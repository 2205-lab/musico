require('dotenv').config();
const { App } = require('@slack/bolt');
const Groq = require('groq-sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const http = require('http');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── CRASH PROTECTION ─────────────────────────────────────
// The socket-mode reconnect bug throws "Unhandled event 'server explicit
// disconnect' in state 'connecting'" which kills the process. These guards
// keep Wavmind alive instead of entering Railway's restart loop.
app.error(async (error) => {
  console.error('Bolt app error (handled):', error?.message || error);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection (handled):', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException (handled):', err?.message || err);
});

// ─── PERSISTENT STORAGE (memory-first, survives Railway /tmp resets) ──
const REMINDERS_FILE = '/tmp/wavmind_reminders.json';
const STATS_FILE = '/tmp/wavmind_stats.json';
const PROJECTS_FILE = '/tmp/wavmind_projects.json';
const PREFS_FILE = '/tmp/wavmind_prefs.json';

global._memoryStore = global._memoryStore || {
  reminders: {}, stats: {}, projects: {}, prefs: {},
};

function loadFile(file, memKey) {
  if (Object.keys(global._memoryStore[memKey]).length > 0) return global._memoryStore[memKey];
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      global._memoryStore[memKey] = data;
      return data;
    }
  } catch (err) { console.error(`Load error ${file}:`, err.message); }
  return {};
}
function saveFile(file, data, memKey) {
  global._memoryStore[memKey] = data;
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
  catch (err) { console.error(`Save error ${file}:`, err.message); }
}

global.pendingReminders = loadFile(REMINDERS_FILE, 'reminders');
global.weeklyStats = loadFile(STATS_FILE, 'stats');
global.userProjects = loadFile(PROJECTS_FILE, 'projects');
global.userPrefs = loadFile(PREFS_FILE, 'prefs');
global.userUploads = global.userUploads || {};
global.samplePageTracker = global.samplePageTracker || {};
global.userFlow = global.userFlow || {};        // ephemeral conversational state
global.pendingAnalysis = global.pendingAnalysis || {};

const saveProjects = () => saveFile(PROJECTS_FILE, global.userProjects, 'projects');
const savePrefs = () => saveFile(PREFS_FILE, global.userPrefs, 'prefs');

function getPrefs(userId) {
  if (!global.userPrefs[userId]) global.userPrefs[userId] = {};
  return global.userPrefs[userId];
}

// ─── SESSIONS / PROJECT MODEL ─────────────────────────────
const SESSION_KEYS = ['recording', 'mixing', 'mastering', 'artwork', 'release', 'promotion'];

function sessionLabel(key) {
  const labels = {
    recording: '🎙️ Recording', mixing: '🎚️ Mixing', mastering: '🔊 Mastering',
    artwork: '🎨 Artwork', release: '🚀 Release', promotion: '📣 Promotion',
  };
  return labels[key] || key;
}

function createProject(userId, name) {
  if (!global.userProjects[userId]) global.userProjects[userId] = [];
  const sessions = {};
  for (const k of SESSION_KEYS) sessions[k] = { done: false, deadline: null };
  const project = {
    id: Date.now().toString(),
    name, createdAt: new Date().toISOString(),
    sessions, completed: false, lastDailyReminder: null,
  };
  global.userProjects[userId].push(project);
  saveProjects();
  return project;
}
const getProjects = (userId) => global.userProjects[userId] || [];
const getActiveProject = (userId) => getProjects(userId).find(p => !p.completed) || null;

function setSessionDeadline(userId, sessionType, isoDate) {
  const project = getActiveProject(userId);
  if (!project) return null;
  project.sessions[sessionType].deadline = isoDate;
  saveProjects();
  return project;
}
function markSessionDone(userId, sessionType) {
  const project = getActiveProject(userId);
  if (!project) return null;
  project.sessions[sessionType].done = true;
  saveProjects();
  return project;
}
function completeProject(userId) {
  const project = getActiveProject(userId);
  if (!project) return null;
  project.completed = true;
  saveProjects();
  return project;
}
function getProjectHealth(project) {
  const sessions = Object.values(project.sessions);
  const done = sessions.filter(s => s.done).length;
  const total = sessions.length;
  return { done, total, percent: Math.round((done / total) * 100) };
}

// ─── HELPERS ──────────────────────────────────────────────
function scoreBar(percent) {
  const p = Math.max(0, Math.min(100, percent || 0));
  const filled = Math.round(p / 10);
  const color = p >= 80 ? '🟢' : p >= 50 ? '🟡' : '🔴';
  return color.repeat(filled) + '⚪'.repeat(10 - filled) + ` ${p}%`;
}
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(dateStr); d.setHours(0, 0, 0, 0);
  return Math.round((d - today) / (1000 * 60 * 60 * 24));
}
function deadlineEmoji(days) {
  if (days === null) return '📅';
  if (days <= 2) return '🔴';
  if (days <= 7) return '🟡';
  return '🟢';
}
function daysPhrase(days) {
  if (days < 0) return `overdue by ${Math.abs(days)} day${Math.abs(days) !== 1 ? 's' : ''}`;
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  return `due in ${days} days`;
}
function todayStr() { return new Date().toISOString().slice(0, 10); }

// ─── FLEXIBLE DATE PARSER (day-first, for any common format) ──
const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};
function parseFlexibleDate(input) {
  if (!input) return null;
  let s = input.trim().toLowerCase().replace(/(\d+)(st|nd|rd|th)/g, '$1').replace(/,/g, ' ').trim();
  const now = new Date();

  // ISO: 2026-06-15
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return mk(+m[1], +m[2] - 1, +m[3]);

  // Day-first numeric: 12/06/2026, 12-06-2026, 12.06.2026, 12/06/26, 12/06
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2,4}))?$/);
  if (m) {
    let day = +m[1], mon = +m[2] - 1;
    let year = m[3] ? +m[3] : now.getFullYear();
    if (year < 100) year += 2000;
    // if "month" > 12 it was actually month/day - swap
    if (mon > 11 && day <= 12) { const t = day; day = mon + 1; mon = t - 1; }
    return mk(year, mon, day);
  }

  // "12 june 2026" / "12 jun" / "june 12 2026" / "jun 12"
  const tokens = s.split(/\s+/).filter(Boolean);
  let day = null, mon = null, year = null;
  for (const tok of tokens) {
    if (/^\d{4}$/.test(tok)) year = +tok;
    else if (/^\d{1,2}$/.test(tok)) { if (day === null) day = +tok; }
    else if (MONTHS[tok] !== undefined) mon = MONTHS[tok];
  }
  if (mon !== null && day !== null) return mk(year || now.getFullYear(), mon, day);

  // Last resort: native parse
  const d = new Date(input);
  return isNaN(d.getTime()) ? null : d;

  function mk(y, mo, da) {
    const d = new Date(y, mo, da, 12, 0, 0);
    return isNaN(d.getTime()) ? null : d;
  }
}

// ─── GROQ AI ──────────────────────────────────────────────
async function askAI(prompt) {
  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: 'You are Wavmind, an expert AI assistant for music producers. Format using Slack mrkdwn. Use *text* for bold. Use • for bullets. Never use ** or # headers. Keep responses clean and scannable.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 1024,
    });
    let text = response.choices[0].message.content;
    text = text.replace(/#{1,6}\s+/g, '');
    text = text.replace(/\*\*([^*]+)\*\*/g, '*$1*');
    text = text.replace(/^-\s+/gm, '• ');
    return text;
  } catch (err) { console.error('Groq error:', err.message); return null; }
}

// ─── TAVILY ───────────────────────────────────────────────
async function tavilySearch(query) {
  try {
    const res = await axios.post('https://api.tavily.com/search',
      { api_key: process.env.TAVILY_API_KEY, query, search_depth: 'basic', max_results: 5, include_answer: true },
      { timeout: 10000 });
    return { answer: res.data.answer || null, results: (res.data.results || []).map(r => ({ title: r.title, url: r.url })) };
  } catch (err) { console.error('Tavily error:', err.message); return null; }
}

// ─── FREESOUND ────────────────────────────────────────────
function mapSounds(results) {
  return results.sort(() => Math.random() - 0.5).map(s => ({
    id: s.id, name: s.name,
    duration: Math.round((s.duration || 0) * 10) / 10,
    license: s.license?.includes('publicdomain') ? 'CC0 — Free' : 'CC Attribution',
    username: s.username,
    preview: s.previews?.['preview-hq-mp3'] || s.previews?.['preview-lq-mp3'] || null,
    url: `https://freesound.org/people/${s.username}/sounds/${s.id}/`,
    downloads: s.num_downloads || 0,
    rating: s.avg_rating ? Math.round(s.avg_rating * 10) / 10 : 0,
    tags: (s.tags || []).slice(0, 6).join(' · '),
  }));
}
function buildSearchQuery(query) {
  const stopWords = /\b(loop|loops|sample|samples|pack|packs|free|download|audio)\b/gi;
  let clean = query.replace(stopWords, '').replace(/\s+/g, ' ').trim();
  if (clean.length < 2) clean = query.trim();
  return clean;
}
function enhanceQuery(query) {
  const lower = query.toLowerCase();
  const enhancements = {
    piano: ['piano melody', 'piano chord', 'piano loop', 'piano riff', 'piano notes'],
    synth: ['synth pad', 'synth lead', 'synth bass', 'synthesizer', 'synth arp'],
    bass: ['bass guitar', 'bass line', 'bass riff', '808 bass', 'sub bass'],
    guitar: ['guitar riff', 'guitar chord', 'electric guitar', 'acoustic guitar'],
    drums: ['drum loop', 'drum beat', 'drum kit', 'trap drums', 'drum pattern'],
    strings: ['string ensemble', 'violin', 'cello', 'string melody', 'orchestral strings'],
    flute: ['flute melody', 'flute loop', 'pan flute', 'flute notes'],
    trumpet: ['trumpet melody', 'brass', 'trumpet loop', 'trumpet riff'],
    saxophone: ['saxophone jazz', 'sax melody', 'alto sax', 'saxophone riff'],
    violin: ['violin melody', 'violin loop', 'violin solo'],
    ambient: ['ambient pad', 'ambient texture', 'ambient drone', 'ambient atmosphere'],
    vocal: ['vocal chop', 'vocal sample', 'vocal melody', 'vocal harmony'],
  };
  for (const [instrument, options] of Object.entries(enhancements)) {
    if (lower.includes(instrument)) return options[Math.floor(Math.random() * options.length)];
  }
  return query;
}
function getNextPage(userId, query) {
  const key = `${userId}_${query.toLowerCase().trim()}`;
  if (!global.samplePageTracker[key]) global.samplePageTracker[key] = [];
  const used = global.samplePageTracker[key];
  let attempts = 0, page;
  do { page = Math.floor(Math.random() * 8) + 1; attempts++; } while (used.includes(page) && attempts < 20);
  used.push(page);
  if (used.length > 6) used.shift();
  global.samplePageTracker[key] = used;
  return page;
}
async function searchFreesound(query, userId = null) {
  try {
    const cleanQuery = buildSearchQuery(query);
    const enhancedQuery = enhanceQuery(cleanQuery);
    const page = userId ? getNextPage(userId, query) : Math.floor(Math.random() * 8) + 1;
    const base = `https://freesound.org/apiv2/search/text/?token=${process.env.FREESOUND_API_KEY}&format=json&page_size=10&fields=id,name,tags,duration,license,username,previews,avg_rating,num_downloads&filter=duration:[1+TO+30]`;
    const url = `${base}&query=${encodeURIComponent(enhancedQuery)}&page=${page}`;
    const res = await axios.get(url, { timeout: 10000 });
    let results = res.data.results || [];
    if (!results.length && page > 1) {
      const fb = await axios.get(`${base}&query=${encodeURIComponent(enhancedQuery)}&page=1`, { timeout: 10000 });
      results = fb.data.results || [];
    }
    if (!results.length) {
      const simple = query.split(' ')[0];
      if (simple !== query) {
        const sr = await axios.get(`${base}&query=${encodeURIComponent(simple)}&page=1`, { timeout: 10000 });
        results = sr.data.results || [];
      }
    }
    if (!results.length) return null;
    return mapSounds(results);
  } catch (err) { console.error('Freesound error:', err.message); return null; }
}

// ─── SPOTIFY ──────────────────────────────────────────────
async function getSpotifyToken() {
  const res = await axios.post('https://accounts.spotify.com/api/token', 'grant_type=client_credentials', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET).toString('base64') },
  });
  return res.data.access_token;
}
async function getTrackFeatures(trackName) {
  try {
    const token = await getSpotifyToken();
    const normalizedQuery = trackName.trim().replace(/\s+/g, ' ');
    let search = await axios.get('https://api.spotify.com/v1/search', {
      headers: { Authorization: `Bearer ${token}` },
      params: { q: normalizedQuery, type: 'track', limit: 1, market: 'US' },
    });
    let track = search.data.tracks.items[0];
    if (!track) {
      const simpleName = normalizedQuery.split(/[-–]|by/i)[0].trim();
      const retry = await axios.get('https://api.spotify.com/v1/search', {
        headers: { Authorization: `Bearer ${token}` },
        params: { q: simpleName, type: 'track', limit: 1, market: 'US' },
      });
      track = retry.data.tracks.items[0];
      if (!track) return null;
    }
    const features = await axios.get(`https://api.spotify.com/v1/audio-features/${track.id}`, { headers: { Authorization: `Bearer ${token}` } });
    const keys = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    return {
      name: track.name, artist: track.artists[0].name,
      bpm: Math.round(features.data.tempo),
      key: keys[features.data.key] + ' ' + ['Minor', 'Major'][features.data.mode],
      energy: Math.round(features.data.energy * 100),
      danceability: Math.round(features.data.danceability * 100),
      loudness: features.data.loudness.toFixed(1),
      valence: Math.round(features.data.valence * 100),
    };
  } catch (err) { console.error('Spotify error:', err.message); return null; }
}
async function getArtistStats(artistName) {
  try {
    const token = await getSpotifyToken();
    const search = await axios.get('https://api.spotify.com/v1/search', { headers: { Authorization: `Bearer ${token}` }, params: { q: artistName, type: 'track', limit: 5 } });
    const tracks = search.data.tracks.items;
    if (!tracks.length) return null;
    const featuresRes = await Promise.all(tracks.map(t => axios.get(`https://api.spotify.com/v1/audio-features/${t.id}`, { headers: { Authorization: `Bearer ${token}` } })));
    const features = featuresRes.map(r => r.data);
    const avg = k => Math.round(features.reduce((s, f) => s + f[k], 0) / features.length);
    const keys = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    return { name: artistName, bpm: avg('tempo'), energy: Math.round(avg('energy')), danceability: Math.round(avg('danceability')), valence: Math.round(avg('valence')), loudness: (features.reduce((s, f) => s + f.loudness, 0) / features.length).toFixed(1), key: keys[Math.abs(avg('key')) % 12] + ' ' + ['Minor', 'Major'][avg('mode') > 0 ? 1 : 0] };
  } catch (err) { console.error('Artist stats error:', err.message); return null; }
}
// New releases relevant to a genre (search recent albums by genre keyword)
async function getNewReleasesByGenre(genre, limit = 6) {
  try {
    const token = await getSpotifyToken();
    const res = await axios.get('https://api.spotify.com/v1/search', {
      headers: { Authorization: `Bearer ${token}` },
      params: { q: `genre:"${genre}"`, type: 'album', limit: 30, market: 'US' },
    });
    let albums = (res.data.albums?.items || []);
    if (!albums.length) {
      // fallback: plain keyword search
      const res2 = await axios.get('https://api.spotify.com/v1/search', {
        headers: { Authorization: `Bearer ${token}` },
        params: { q: genre, type: 'album', limit: 30, market: 'US' },
      });
      albums = res2.data.albums?.items || [];
    }
    const withDates = albums
      .filter(a => a.release_date)
      .map(a => ({
        name: a.name,
        artist: a.artists?.[0]?.name || 'Unknown',
        date: a.release_date,
        url: a.external_urls?.spotify || `https://open.spotify.com/album/${a.id}`,
        ts: new Date(a.release_date).getTime() || 0,
      }))
      .sort((x, y) => y.ts - x.ts)
      .slice(0, limit);
    return withDates;
  } catch (err) { console.error('New releases error:', err.message); return null; }
}

// ─── AUDIO ANALYSIS ───────────────────────────────────────
async function analyzeAudioFile(fileUrl, filename) {
  const filePath = path.join('/tmp', filename.replace(/[^a-zA-Z0-9._-]/g, '_'));
  try {
    const response = await axios.get(fileUrl, { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }, responseType: 'arraybuffer', timeout: 30000 });
    fs.writeFileSync(filePath, response.data);
    const result = execSync(`python3 analyze.py "${filePath}"`, { timeout: 90000 }).toString().trim();
    const analysis = JSON.parse(result);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return analysis;
  } catch (err) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { error: err.message };
  }
}
// Human-readable interpretation of loudness vs streaming standard (-14 LUFS)
function loudnessVerdict(lufs) {
  if (lufs === null || lufs === undefined) return 'Unknown';
  if (lufs > -7) return `${lufs} LUFS — very loud / likely over-compressed`;
  if (lufs > -11) return `${lufs} LUFS — loud, club/master level`;
  if (lufs >= -15) return `${lufs} LUFS — streaming-ready (target ~-14)`;
  if (lufs >= -20) return `${lufs} LUFS — a bit quiet, room to master louder`;
  return `${lufs} LUFS — quiet, needs mastering for streaming`;
}
function balanceLabel(low, mid, high) {
  const max = Math.max(low, mid, high);
  if (max === low) return 'low-heavy (lots of bass)';
  if (max === high) return 'high-heavy (bright/airy)';
  return 'mid-forward (vocals/instruments up front)';
}

// ─── BLOCK KIT HELPERS ────────────────────────────────────
const divider = () => ({ type: 'divider' });
const header = t => ({ type: 'header', text: { type: 'plain_text', text: t, emoji: true } });
const section = t => ({ type: 'section', text: { type: 'mrkdwn', text: t } });
const twoCol = (l, r) => ({ type: 'section', fields: [{ type: 'mrkdwn', text: l || '—' }, { type: 'mrkdwn', text: r || '—' }] });
const context = t => ({ type: 'context', elements: [{ type: 'mrkdwn', text: t }] });
const btn = (text, actionId, style) => { const b = { type: 'button', text: { type: 'plain_text', text, emoji: true }, action_id: actionId }; if (style) b.style = style; return b; };
const actions = btns => ({ type: 'actions', elements: btns });
// Always attach a text fallback so Slack stops warning + push notifications work
const reply = (blocks, text) => ({ blocks, text: text || 'Wavmind' });

// ─── COMPARE SESSIONS ─────────────────────────────────────
global.compareSessions = global.compareSessions || {};
const getCompareSession = id => global.compareSessions[id] || null;
const startCompareSession = id => { global.compareSessions[id] = { status: 'waiting_your_track', yourTrack: null, referenceTrack: null, startedAt: new Date().toISOString() }; return global.compareSessions[id]; };
const clearCompareSession = id => { delete global.compareSessions[id]; };

// ─── TRACK UPLOAD TRACKING ────────────────────────────────
function trackUpload(userId, filename, analysis) {
  if (!global.pendingReminders[userId]) global.pendingReminders[userId] = [];
  global.pendingReminders[userId].push({
    filename, analysis,
    uploadedAt: new Date().toISOString(),
    remindAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    sent: false,
  });
  saveFile(REMINDERS_FILE, global.pendingReminders, 'reminders');
  if (!global.userUploads[userId]) global.userUploads[userId] = [];
  global.userUploads[userId].push({ filename, analysis, timestamp: new Date().toISOString() });
  if (!global.weeklyStats[userId]) global.weeklyStats[userId] = { tracks: 0, issues: [] };
  global.weeklyStats[userId].tracks++;
  if (analysis.lufs !== undefined && analysis.lufs < -18) global.weeklyStats[userId].issues.push('Quiet master');
  if (analysis.low_pct > 45) global.weeklyStats[userId].issues.push('Heavy low end');
  if (analysis.stereo_width !== undefined && analysis.stereo_width < 8) global.weeklyStats[userId].issues.push('Narrow stereo');
  saveFile(STATS_FILE, global.weeklyStats, 'stats');
}

// ─── SAMPLES BUILDER ──────────────────────────────────────
async function buildSamplesResponse(query, userId) {
  const sounds = await searchFreesound(query, userId);
  if (!sounds || !sounds.length) {
    return [header('❗ No Results'), section(`No sounds for *"${query}"*.\n\nTry: piano · drums · bass · guitar · synth`), section(`🔗 *<https://freesound.org/search/?q=${encodeURIComponent(query)}|Browse Freesound>*`)];
  }
  const aiTip = await askAI(`Producer looking for "${query}" samples. 2-3 quick production tips. Under 50 words. Bullets.`);
  const blocks = [header(`🎵 Free Samples: "${query}"`), section(`*${sounds.length} sounds* — all free · _Search again for different results_`), context('🔊 Listen to preview · 📥 Download for file'), divider()];
  sounds.forEach((s, i) => {
    blocks.push(section(`*${i + 1}. ${s.name}*\n⏱️ *${s.duration}s* · ⭐ *${s.rating}/5* · 📥 *${s.downloads.toLocaleString()}*\n📄 ${s.license} · 👤 ${s.username}\n🏷️ ${s.tags}\n\n${s.preview ? `🔊 *<${s.preview}|▶ Listen>*     ` : ''}🔗 *<${s.url}|📥 Download>*`));
    if (i < sounds.length - 1) blocks.push(divider());
  });
  if (aiTip) blocks.push(divider(), header(`💡 Tips for ${query} samples`), section(aiTip));
  blocks.push(divider(), section(`🔗 *<https://freesound.org/search/?q=${encodeURIComponent(query)}|Browse more on Freesound>*`), context('Creative Commons · Search again for different sounds'));
  return blocks;
}

// ─── PROJECT BLOCKS ───────────────────────────────────────
function projectSessionsText(project) {
  return SESSION_KEYS.map(key => {
    const s = project.sessions[key];
    const status = s.done ? '✅' : '☐';
    if (!s.deadline) return `${status} *${sessionLabel(key)}* — _no deadline_`;
    const days = daysUntil(s.deadline);
    const d = new Date(s.deadline).toLocaleDateString();
    return `${status} *${sessionLabel(key)}* — ${deadlineEmoji(days)} ${daysPhrase(days)} (${d})`;
  }).join('\n');
}
function buildProjectBlocks(project) {
  const health = getProjectHealth(project);
  return [
    header(`📋 ${project.name}`),
    section(`*Progress:* ${scoreBar(health.percent)}\n*Sessions:* ${health.done}/${health.total} complete`),
    divider(),
    section(projectSessionsText(project)),
    divider(),
    section('*Set / change a deadline* — just type (any date format):\nrecording 12/06/2026 · mixing 15/06/2026 · mastering 18/06/2026\nartwork 20/06/2026 · release 25/06/2026 · promotion 28/06/2026'),
    section('*Mark done:* type `done mixing`  ·  *Finish:* type `complete project`'),
  ];
}
function deadlinePromptBlocks(project) {
  return [
    header(`📋 ${project.name} — Created!`),
    section(`${scoreBar(0)}`),
    divider(),
    section('*Now set your deadlines.* Just type any of these — *any date format works* (12/06/2026, 15 June 2026, 2026-06-18):'),
    section('recording 12/06/2026\nmixing 15/06/2026\nmastering 18/06/2026\nartwork 20/06/2026\nrelease 25/06/2026\npromotion 28/06/2026'),
    context('🤖 I\'ll remind you each day as sessions get close. Type `show project` anytime.'),
  ];
}

// ─── WELCOME / MENUS ──────────────────────────────────────
function getWelcomeBlocks() {
  return [
    header('🎛️ Hey! I\'m Wavmind 👋'),
    section('Your autonomous AI music production agent. *Just talk to me naturally:*\n\n• "start project" — plan a release with deadline reminders\n• upload a track — I scan loudness, stereo, spectral balance\n• "compare" — A/B your track vs a reference\n• "feedback" — mix critique on your last upload\n• "find me trap drums" — free samples\n• "new releases" — latest drops in your genre\n• "teach me fl studio" — daily DAW lessons'),
    divider(),
    actions([btn('📋 Start a Project', 'start_project'), btn('🆚 Compare Tracks', 'quick_compare')]),
    actions([btn('🎵 Find Samples', 'menu_create'), btn('🎓 DAW Guru', 'daw_guru')]),
    divider(),
    context('💡 DM me or @mention me — no slash commands needed'),
  ];
}
function getCreateBlocks() {
  return [
    header('🎹 Make Music'),
    divider(),
    section('*🎵 Free Samples — different every search*\nType: samples drums · samples piano · samples bass · samples synth'),
    section('*💡 Track Ideas*\nType: ideas dark trap'),
    section('*🎹 Chord Progressions*\nType: chords F minor trap'),
    section('*🎹 DAW Help*\nType: daw fl studio sidechain 808'),
    divider(),
    actions([btn('← Back', 'menu_main')]),
  ];
}

// ─── BUTTON HANDLERS ──────────────────────────────────────
app.action('menu_main', async ({ body, ack, client }) => { await ack(); await client.chat.postMessage({ channel: body.user.id, ...reply(getWelcomeBlocks(), 'Wavmind menu') }); });
app.action('menu_create', async ({ body, ack, client }) => { await ack(); await client.chat.postMessage({ channel: body.user.id, ...reply(getCreateBlocks(), 'Make music') }); });
app.action('start_project', async ({ body, ack, client }) => {
  await ack();
  global.userFlow[body.user.id] = { state: 'awaiting_project_name' };
  await client.chat.postMessage({ channel: body.user.id, ...reply([header('📋 New Project'), section('What\'s the name of your project? Just type it below.')], 'Name your project') });
});
app.action('quick_compare', async ({ body, ack, client }) => {
  await ack();
  startCompareSession(body.user.id);
  await client.chat.postMessage({ channel: body.user.id, ...reply([header('🆚 Comparison Started'), section('*Step 1* — upload YOUR track\n*Step 2* — upload your REFERENCE track\n\nI compare loudness, stereo width, spectral balance & frequency automatically.'), context('To cancel type `cancel`')], 'Compare started') });
});
app.action('daw_guru', async ({ body, ack, client }) => {
  await ack();
  await client.chat.postMessage({
    channel: body.user.id, ...reply([
      header('🎓 DAW Guru'),
      section('I\'ll send you a short daily lesson for your DAW. First — what\'s your level?'),
      actions([btn('🌱 Beginner', 'level_beginner', 'primary'), btn('⚡ Intermediate', 'level_intermediate'), btn('🔥 Advanced', 'level_advanced')]),
    ], 'Pick your DAW level'),
  });
});
['beginner', 'intermediate', 'advanced'].forEach(level => {
  app.action(`level_${level}`, async ({ body, ack, client }) => {
    await ack();
    const p = getPrefs(body.user.id);
    p.skillLevel = level;
    savePrefs();
    global.userFlow[body.user.id] = { state: 'awaiting_daw' };
    await client.chat.postMessage({ channel: body.user.id, ...reply([header(`🎓 Level: ${level}`), section('Which DAW are you using? (e.g. *FL Studio*, *Ableton*, *Logic Pro*)\n\nJust type it below.')], 'Which DAW?') });
  });
});
app.action('quick_feedback', async ({ body, ack, client }) => {
  await ack();
  await handleFeedback(body.user.id, async (b, t) => client.chat.postMessage({ channel: body.user.id, ...reply(b, t) }));
});

// ─── APP HOME (crash-fixed: no empty fields) ──────────────
async function publishAppHome(client, userId) {
  const uploads = global.userUploads[userId] || [];
  const lastUpload = uploads[uploads.length - 1];
  const stats = global.weeklyStats[userId];
  const activeProject = getActiveProject(userId);
  const prefs = global.userPrefs[userId] || {};

  const blocks = [section('*🎛️ Wavmind*\n_Your autonomous AI music production agent_'), divider()];

  if (activeProject) {
    const health = getProjectHealth(activeProject);
    blocks.push(header('📋 Active Project'));
    blocks.push(section(`*${activeProject.name}*\n${scoreBar(health.percent)}`));
    blocks.push(section(projectSessionsText(activeProject)));   // single section — NO empty fields
    blocks.push(actions([btn('📋 View Project', 'menu_main'), btn('🆚 Compare Tracks', 'quick_compare')]), divider());
  }

  if (lastUpload && lastUpload.analysis) {
    const a = lastUpload.analysis;
    blocks.push(
      header('📊 Your Last Track'),
      section(`🎵 *${lastUpload.filename}*`),
      twoCol(`⚡ *Energy*\n${scoreBar(a.energy)}`, `🔊 *Loudness*\n${a.lufs !== undefined ? a.lufs + ' LUFS' : '—'}`),
      twoCol(`🎚️ *Stereo Width*\n${a.stereo_width !== undefined ? a.stereo_width + '%' : '—'}`, `🌈 *Brightness*\n${a.brightness || '—'}`),
      twoCol(`📊 *Low / Mid / High*\n${a.low_pct ?? '—'}% / ${a.mid_pct ?? '—'}% / ${a.high_pct ?? '—'}%`, `🎤 *Vocal Clarity*\n${a.vocal_clarity !== undefined ? a.vocal_clarity + '%' : '—'}`),
      context(`_Scanned ${new Date(lastUpload.timestamp).toLocaleDateString()}_`),
      actions([btn('🆚 Compare', 'quick_compare', 'primary'), btn('🎚️ Get Feedback', 'quick_feedback')]),
      divider()
    );
  }

  if (stats && stats.tracks > 0) {
    blocks.push(header('📈 This Week'), twoCol(`🎵 *Tracks Scanned*\n${stats.tracks}`, `⚠️ *Top Issue*\n${stats.issues[0] || 'None'}`), divider());
  }

  blocks.push(
    header('💬 Talk to Me Directly'),
    section('• "start project"\n• "compare"\n• "feedback"\n• "find me trap drums"\n• "new releases"\n• "teach me ableton"'),
    divider(),
    header('🤖 Autonomous Features'),
    section('• *Daily project reminders* — each session as it gets close\n• *24hr track follow-up* after uploads\n• *New release alerts* in your genre' + (prefs.genre ? ` (set: *${prefs.genre}*)` : '') + '\n• *Daily DAW lessons*' + (prefs.daw ? ` (set: *${prefs.daw}*, ${prefs.skillLevel || 'beginner'})` : '') + '\n• *MCP Server* — AI agents can connect'),
    divider(),
    header('⚡ Powered By'),
    twoCol('🤖 *Groq AI* — Llama 3.1', '🎵 *Spotify* — audio data'),
    twoCol('🔍 *Tavily* — real-time search', '🎵 *Freesound* — 500K+ samples'),
    twoCol('🎧 *Librosa + pyloudnorm* — deep analysis', '🔌 *MCP* — agent protocol'),
    divider(),
    context('🎛️ *Wavmind* — just DM me and talk naturally')
  );

  await client.views.publish({ user_id: userId, view: { type: 'home', blocks } });
}
app.event('app_home_opened', async ({ event, client }) => {
  try { await publishAppHome(client, event.user); } catch (err) { console.error('Home error:', err.message); }
});

// ─── FEEDBACK (no BPM/key — uses uploaded analysis) ───────
async function handleFeedback(userId, send) {
  const uploads = global.userUploads[userId] || [];
  const last = uploads[uploads.length - 1];
  if (!last || !last.analysis || last.analysis.error) {
    await send([header('🎚️ Mix Feedback'), section('Upload an MP3 or WAV first, then ask for feedback and I\'ll critique it on:\n• Vocal clarity\n• Kick & bass in the mix\n• Loudness vs industry\n• Spectral balance & frequency')], 'Upload a track first');
    return;
  }
  const a = last.analysis;
  await send([header('🎚️ Analyzing your mix...'), context('⏳')], 'Analyzing');
  const prompt = `You are a professional mixing/mastering engineer. Give specific, actionable feedback on this track based on its measured analysis. Do NOT ask for BPM or key.

MEASURED DATA for "${last.filename}":
• Integrated loudness: ${a.lufs} LUFS (streaming target ~-14 LUFS)
• Stereo width: ${a.stereo_width}% (${a.is_stereo ? 'stereo' : 'mono'} file)
• Spectral balance: low ${a.low_pct}% / mid ${a.mid_pct}% / high ${a.high_pct}% — ${balanceLabel(a.low_pct, a.mid_pct, a.high_pct)}
• Spectral centroid (brightness): ${a.spectral_centroid} Hz
• Vocal clarity proxy: ${a.vocal_clarity}%
• Energy: ${a.energy}%

Cover these sections with concrete moves (EQ ranges in Hz, compression, real plugin names):
1) Vocal clarity
2) Kick & bass in the mix
3) Loudness vs industry (is it mastered loud enough / too much?)
4) Spectral balance & frequency
Top 3 priority fixes at the end.`;
  const r = await askAI(prompt);
  await send([
    header('🎛️ Mix Feedback'),
    section(`🎵 *${last.filename}*`),
    twoCol(`🔊 *Loudness*\n${loudnessVerdict(a.lufs)}`, `🎚️ *Stereo Width*\n${a.stereo_width}%`),
    twoCol(`📊 *Low/Mid/High*\n${a.low_pct}% / ${a.mid_pct}% / ${a.high_pct}%`, `🎤 *Vocal Clarity*\n${a.vocal_clarity}%`),
    divider(),
    section(r || 'Could not generate feedback. Try again.'),
    divider(),
    actions([btn('🆚 Compare with Reference', 'quick_compare', 'primary')]),
  ], 'Mix feedback ready');
}

// ─── DM + CHANNEL HANDLER ─────────────────────────────────
app.message(async ({ message, say, client }) => {
  if (message.subtype || !message.text) return;
  const userId = message.user;
  const text = message.text.trim();
  const lower = text.toLowerCase();

  if (message.channel_type === 'im') {
    const send = async (blocks, t) => say(reply(blocks, t));

    // 1) Conversational flow states
    const flow = global.userFlow[userId];
    if (flow?.state === 'awaiting_project_name') {
      delete global.userFlow[userId];
      const project = createProject(userId, text.replace(/^["']|["']$/g, '') || 'My Project');
      await send(deadlinePromptBlocks(project), 'Project created');
      try { await publishAppHome(client, userId); } catch (e) {}
      return;
    }
    if (flow?.state === 'awaiting_daw') {
      delete global.userFlow[userId];
      const p = getPrefs(userId);
      p.daw = text.replace(/^["']|["']$/g, '');
      p.dawLessonsEnabled = true;
      p.lastLessonReminder = null;
      savePrefs();
      const lesson = await askAI(`Give a ${p.skillLevel || 'beginner'} ${p.daw} producer their first daily micro-lesson. One focused technique with 3-4 concrete steps. Under 120 words.`);
      await send([header(`🎓 DAW Guru — ${p.daw}`), section(`Level: *${p.skillLevel}* · Daily lessons *enabled* ✅`), divider(), section(lesson || 'Lesson coming tomorrow!'), context('I\'ll send a new lesson each day. Type `stop lessons` to pause.')], 'DAW Guru enabled');
      return;
    }
    if (flow?.state === 'awaiting_genre') {
      delete global.userFlow[userId];
      const p = getPrefs(userId);
      p.genre = text.replace(/^["']|["']$/g, '');
      p.releasesEnabled = true;
      p.lastReleaseReminder = null;
      savePrefs();
      await send([header('🎵 New Release Alerts ✅'), section(`Genre set to *${p.genre}*. I\'ll DM you the latest drops daily.`), divider(), section('Want them now? Type `new releases`.')], 'Genre set');
      return;
    }

    // 2) Greetings / menu
    if (['hi', 'hello', 'hey', 'start', 'help', 'menu'].includes(lower)) { await send(getWelcomeBlocks(), 'Welcome'); return; }

    // 3) Start project
    if (/^(start|new|create)\s+project/.test(lower) || lower === 'start project') {
      global.userFlow[userId] = { state: 'awaiting_project_name' };
      await send([header('📋 New Project'), section('What\'s the name of your project? Just type it below.')], 'Name your project');
      return;
    }

    // 4) Deadline line: "recording 12/06/2026"
    const dl = lower.match(/^(recording|mixing|mastering|artwork|release|promotion)\s+(.+)$/);
    if (dl) { if (await handleDeadlineLine(userId, dl[1], dl[2], send, client)) return; }

    // 5) Project view / done / complete
    if (/(^|\b)(show|view|my)\s+project/.test(lower) || lower === 'project') {
      const project = getActiveProject(userId);
      if (!project) { global.userFlow[userId] = { state: 'awaiting_project_name' }; await send([header('📋 No Active Project'), section('Let\'s start one. What\'s the project name?')], 'Start a project'); }
      else await send(buildProjectBlocks(project), 'Your project');
      return;
    }
    const doneM = lower.match(/^(?:mark\s+)?done\s+(recording|mixing|mastering|artwork|release|promotion)$/);
    if (doneM) { await markDone(userId, doneM[1], send, client); return; }
    if (/^complete project$|^finish project$/.test(lower)) { await completeActive(userId, send, client); return; }

    // 6) DAW Guru setup / stop
    if (/(teach|learn|tutor|daw guru|guru)/.test(lower) && /(fl studio|ableton|logic|cubase|pro tools|studio one|reaper|bitwig|garageband|daw|guru|me)/.test(lower)) {
      await send([header('🎓 DAW Guru'), section('I\'ll send a short daily lesson. First — your level?'), actions([btn('🌱 Beginner', 'level_beginner', 'primary'), btn('⚡ Intermediate', 'level_intermediate'), btn('🔥 Advanced', 'level_advanced')])], 'Pick level');
      return;
    }
    if (/^stop lessons$/.test(lower)) { const p = getPrefs(userId); p.dawLessonsEnabled = false; savePrefs(); await send([header('🎓 Lessons paused'), section('Type `teach me [daw]` to resume.')], 'Lessons paused'); return; }

    // 7) New releases
    if (/(new release|latest release|new music|new drops)/.test(lower)) {
      const p = getPrefs(userId);
      if (!p.genre) { global.userFlow[userId] = { state: 'awaiting_genre' }; await send([header('🎵 New Release Alerts'), section('What genre should I track? (e.g. *trap*, *lo-fi*, *house*, *afrobeats*)')], 'Pick genre'); return; }
      await sendReleases(userId, send);
      return;
    }
    if (/^set genre/.test(lower)) {
      const g = text.replace(/^set genre/i, '').trim();
      if (g) { const p = getPrefs(userId); p.genre = g; p.releasesEnabled = true; p.lastReleaseReminder = null; savePrefs(); await send([header('🎵 Genre set ✅'), section(`Tracking *${g}*. Type \`new releases\` to see drops now.`)], 'Genre set'); }
      else { global.userFlow[userId] = { state: 'awaiting_genre' }; await send([section('What genre? Type it below.')], 'Pick genre'); }
      return;
    }

    // 8) Compare
    if (/^compare/.test(lower) || lower.includes('compare track') || lower.includes('reference track')) {
      startCompareSession(userId);
      await send([header('🆚 Comparison Mode'), section('*Step 1* — upload YOUR track\n*Step 2* — upload your REFERENCE track\n\nI auto-compare loudness, stereo width, spectral balance & frequency, then recommend fixes.'), context('To cancel type `cancel`')], 'Compare started');
      return;
    }
    if (lower === 'cancel') { clearCompareSession(userId); await send([header('🗑️ Cancelled')], 'Cancelled'); return; }

    // 9) Feedback
    if (/feedback|critique|review my|how('|)?s my mix|whats wrong with my/.test(lower)) { await handleFeedback(userId, send); return; }

    // 10) Samples
    if (/(sample|drum|piano|bass|guitar|synth|loop|808|hi.?hat|snare|kick|vocal|pad|string|flute|brass)/.test(lower) && !/feedback|mix/.test(lower)) {
      const q = text.replace(/find|search|get|i need|show me|give me|looking for|find me|search for|some|me/gi, '').trim() || 'drums';
      await send([section(`🔍 Finding *${q}* samples...`), context('⏳')], 'Searching');
      await send(await buildSamplesResponse(q, userId), 'Samples');
      return;
    }

    // 11) DAW how-to help
    if (/(fl studio|ableton|logic|cubase|pro tools|studio one|reaper|bitwig|garageband|sidechain|warp|how do i|how to)/.test(lower)) {
      await send([section('🎹 Searching for DAW help...'), context('⏳')], 'Searching');
      const [tav, ai] = await Promise.all([tavilySearch(`${text} tutorial step by step`), askAI(`Expert DAW instructor. Answer: "${text}". Numbered steps. Bold key terms.`)]);
      const blocks = [header('🎹 DAW Help'), section('🤖 *AI Answer:*'), section(ai || 'Error')];
      if (tav?.answer) blocks.push(divider(), section('🌐 *From the Web:*'), section(tav.answer));
      if (tav?.results?.length) blocks.push(divider(), section('📚 *Resources:*'), section(tav.results.slice(0, 3).map(r => `• <${r.url}|${r.title}>`).join('\n')));
      await send(blocks, 'DAW help');
      return;
    }

    // 12) Chords / ideas / bpm
    if (/chord|progression/.test(lower)) { const r = await askAI(`Music theory expert. Chord question: "${text}". Chord names, Roman numerals, feel.`); await send([header('🎹 Chord Help'), section(r || 'Error')], 'Chords'); return; }
    if (/idea|concept|what should i make|suggest/.test(lower)) { const r = await askAI(`Creative producer. "${text}". 3-5 track ideas with BPM, key, concept.`); await send([header('🎵 Track Ideas'), section(r || 'Error')], 'Ideas'); return; }
    if (/\bbpm\b|tempo/.test(lower)) { const r = await askAI(`Production expert. "${text}". Specific BPM/key numbers.`); await send([header('🥁 BPM & Key'), section(r || 'Error')], 'BPM'); return; }

    // 13) Fallback general
    const r = await askAI(`You are Wavmind, expert AI for music producers. The producer said: "${text}". Helpful, specific, professional.`);
    await send([section(r || 'Could not respond. Try `help`.'), context('Type `help` for the menu')], 'Wavmind');
    return;
  }

  // ─── Channel monitoring (threads) ───
  const keywords = ['muddy', '808', 'sidechain', 'compress', 'reverb', 'mixing', 'mastering', 'plugin', 'vst', 'fl studio', 'ableton', 'logic pro', 'melody', 'chord', 'bass line', 'hi-hat', 'kick', 'snare', 'bpm'];
  if (keywords.some(kw => lower.includes(kw)) && !lower.startsWith('/') && Math.random() < 0.33) {
    try {
      const r = await askAI(`Producer said: "${text}". 2-sentence tip + one suggestion. Conversational.`);
      if (r) await say({ thread_ts: message.ts, ...reply([section(`🎛️ *Wavmind:* ${r}`), context('DM me to chat')], 'Tip') });
    } catch (err) { console.error('Monitor error:', err.message); }
  }
});

// ─── Shared conversational actions ───
async function handleDeadlineLine(userId, sessionType, dateText, send, client) {
  const project = getActiveProject(userId);
  if (!project) { global.userFlow[userId] = { state: 'awaiting_project_name' }; await send([header('📋 No Active Project'), section('Let\'s start one first. What\'s the project name?')], 'Start a project'); return true; }
  const parsed = parseFlexibleDate(dateText);
  if (!parsed) { await send([header('❗ Couldn\'t read that date'), section(`Try: \`${sessionType} 12/06/2026\` or \`${sessionType} 15 June 2026\``)], 'Bad date'); return true; }
  setSessionDeadline(userId, sessionType, parsed.toISOString());
  const days = daysUntil(parsed.toISOString());
  await send([header(`📅 ${sessionLabel(sessionType)} deadline set`), section(`*${parsed.toLocaleDateString()}* — ${deadlineEmoji(days)} ${daysPhrase(days)}`), divider(), section(projectSessionsText(project)), context('Set another, or type `show project`')], 'Deadline set');
  try { await publishAppHome(client, userId); } catch (e) {}
  return true;
}
async function markDone(userId, sessionType, send, client) {
  const project = getActiveProject(userId);
  if (!project) { await send([header('❗ No Active Project')], 'No project'); return; }
  markSessionDone(userId, sessionType);
  const health = getProjectHealth(project);
  const allDone = health.done === health.total;
  await send([header(`✅ ${sessionLabel(sessionType)} done!`), section(`*${project.name}*\n${scoreBar(health.percent)}`), divider(), section(allDone ? '🎉 *All sessions complete!* Type `complete project` to finish.' : `${health.done}/${health.total} done — keep going!`)], 'Session done');
  try { await publishAppHome(client, userId); } catch (e) {}
}
async function completeActive(userId, send, client) {
  const project = getActiveProject(userId);
  if (!project) { await send([header('❗ No Active Project')], 'No project'); return; }
  completeProject(userId);
  await send([header('🎉 Project Complete!'), section(`*${project.name}* is done — congrats! 🚀`), divider(), section('Start another: type `start project`')], 'Project complete');
  try { await publishAppHome(client, userId); } catch (e) {}
}
async function sendReleases(userId, send) {
  const p = getPrefs(userId);
  await send([section(`🔍 Finding latest *${p.genre}* releases...`), context('⏳')], 'Searching');
  const releases = await getNewReleasesByGenre(p.genre);
  if (!releases || !releases.length) { await send([header('🎵 New Releases'), section(`Couldn\'t find recent *${p.genre}* releases right now. Try a broader genre.`)], 'No releases'); return; }
  const lines = releases.map(r => `• *<${r.url}|${r.name}>* — ${r.artist} _(${r.date})_`).join('\n');
  await send([header(`🎵 Latest in ${p.genre}`), section(lines), divider(), context('🤖 I\'ll DM you new drops daily · type `set genre [x]` to change')], 'New releases');
}

// ─── APP MENTION ──────────────────────────────────────────
app.event('app_mention', async ({ event, say }) => {
  const input = event.text.replace(/<@[^>]+>/g, '').trim();
  const send = async (blocks, t) => say(reply(blocks, t));
  if (!input) { await send(getWelcomeBlocks(), 'Welcome'); return; }
  const lower = input.toLowerCase();
  if (/(sample|drum|piano|bass|guitar|synth|loop)/.test(lower)) { await send(await buildSamplesResponse(input.replace(/find|search|get|me|some/gi, '').trim(), event.user), 'Samples'); return; }
  if (/feedback|mix/.test(lower)) { await handleFeedback(event.user, send); return; }
  const r = await askAI(`You are Wavmind, expert AI for music producers. Answer: "${input}"`);
  await send([section(`<@${event.user}>`), section(r || 'Error'), context('DM me to chat')], 'Wavmind');
});

// ─── FILE UPLOAD ──────────────────────────────────────────
app.event('file_shared', async ({ event, client }) => {
  try {
    const fileInfo = await client.files.info({ file: event.file_id });
    const file = fileInfo.file;
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg'].includes(ext)) return;
    const userId = event.user_id;
    const channelId = event.channel_id;
    const post = (blocks, t) => client.chat.postMessage({ channel: channelId, ...reply(blocks, t) });
    const compareSession = userId ? getCompareSession(userId) : null;

    if (compareSession) {
      if (compareSession.status === 'waiting_your_track') {
        await post([header('🎵 Scanning Your Track...'), section(`*${file.name}*`), context('⏳ Step 1 of 2')], 'Scanning');
        const a = await analyzeAudioFile(file.url_private_download, file.name);
        if (!a || a.error) { await post([header('❗ Scan Failed'), section('Try an MP3 or WAV under ~15MB.')], 'Scan failed'); return; }
        compareSession.yourTrack = { filename: file.name, ...a };
        compareSession.status = 'waiting_reference';
        await post([
          header('✅ Your Track Scanned — Step 1 of 2'),
          section(`*${file.name}*`),
          twoCol(`🔊 *Loudness*\n${a.lufs} LUFS`, `🎚️ *Stereo*\n${a.stereo_width}%`),
          twoCol(`📊 *L/M/H*\n${a.low_pct}/${a.mid_pct}/${a.high_pct}%`, `⚡ *Energy*\n${a.energy}%`),
          divider(),
          header('🎯 Step 2 — Upload Your Reference Track'),
          section('Upload the song you want to sound like.'),
        ], 'Track scanned');
      } else if (compareSession.status === 'waiting_reference') {
        await post([header('🔍 Scanning Reference...'), section(`*${file.name}*`), context('⏳ Generating comparison...')], 'Scanning');
        const a = await analyzeAudioFile(file.url_private_download, file.name);
        if (!a || a.error) { await post([header('❗ Scan Failed'), section('Try an MP3 or WAV under ~15MB.')], 'Scan failed'); return; }
        compareSession.referenceTrack = { filename: file.name, ...a };
        const y = compareSession.yourTrack, r = compareSession.referenceTrack;
        clearCompareSession(userId);

        const gap = (mine, ref, unit, goodWithin) => {
          const diff = +(ref - mine).toFixed(1);
          const status = Math.abs(diff) <= goodWithin ? '✅ Match' : (diff > 0 ? '🔴 Ref higher' : '🟢 Yours higher');
          return `${mine}${unit} → ${ref}${unit}  ${status}`;
        };
        const aiPrompt = `Professional mastering engineer. Compare my track to the reference using MEASURED data and give specific fixes (EQ in Hz, compression, stereo tools, limiter, real plugin names). Do not ask for more info.

MINE "${y.filename}": loudness ${y.lufs} LUFS, stereo ${y.stereo_width}%, low/mid/high ${y.low_pct}/${y.mid_pct}/${y.high_pct}%, brightness ${y.spectral_centroid}Hz, energy ${y.energy}%
REFERENCE "${r.filename}": loudness ${r.lufs} LUFS, stereo ${r.stereo_width}%, low/mid/high ${r.low_pct}/${r.mid_pct}/${r.high_pct}%, brightness ${r.spectral_centroid}Hz, energy ${r.energy}%

Give: 1) Loudness 2) Spectral balance / frequency (more lows/mids/highs?) 3) Stereo width 4) Energy. Then "Top 3 moves to match the reference".`;
        const ai = await askAI(aiPrompt);
        await post([
          header('🆚 Mix Comparison Report'),
          twoCol(`🎵 *Yours*\n${y.filename}`, `🎯 *Reference*\n${r.filename}`),
          divider(),
          section('*📊 Measured Differences*'),
          section([
            `🔊 *Loudness* — ${gap(y.lufs, r.lufs, ' LUFS', 1.5)}`,
            `🎚️ *Stereo Width* — ${gap(y.stereo_width, r.stereo_width, '%', 8)}`,
            `🟥 *Lows* — ${gap(y.low_pct, r.low_pct, '%', 5)}`,
            `🟩 *Mids* — ${gap(y.mid_pct, r.mid_pct, '%', 5)}`,
            `🟦 *Highs* — ${gap(y.high_pct, r.high_pct, '%', 5)}`,
            `⚡ *Energy* — ${gap(y.energy, r.energy, '%', 6)}`,
          ].join('\n')),
          divider(),
          header('🤖 How to Match the Reference'),
          section(ai || 'Could not generate.'),
          divider(),
          actions([btn('🆚 Compare Again', 'quick_compare', 'primary')]),
        ], 'Comparison ready');
      }
      return;
    }

    // Normal upload → scan + store (feedback available on request)
    await post([header('🎵 Scanning Your Track...'), section(`*${file.name}*`), context('⏳ Deep analysis: loudness, stereo, spectral...')], 'Scanning');
    const a = await analyzeAudioFile(file.url_private_download, file.name);
    if (!a || a.error) { await post([header('❗ Scan Failed'), section('Try an MP3 or WAV under ~15MB.')], 'Scan failed'); return; }
    if (userId) trackUpload(userId, file.name, a);
    global.pendingAnalysis[channelId] = { filename: file.name, ...a };

    await post([
      header('🎛️ Scan Complete'),
      section(`*${file.name}*`),
      twoCol(`🔊 *Loudness*\n${loudnessVerdict(a.lufs)}`, `🎚️ *Stereo Width*\n${a.stereo_width}%`),
      twoCol(`📊 *Low / Mid / High*\n${a.low_pct}% / ${a.mid_pct}% / ${a.high_pct}%`, `🎤 *Vocal Clarity*\n${a.vocal_clarity}%`),
      twoCol(`⚡ *Energy*\n${scoreBar(a.energy)}`, `🌈 *Brightness*\n${a.brightness}`),
      divider(),
      section('*What next?*'),
      actions([btn('🎚️ Get Mix Feedback', 'quick_feedback', 'primary'), btn('🆚 Compare with Reference', 'quick_compare')]),
      context('🤖 I\'ll DM you a follow-up reminder tomorrow'),
    ], 'Scan complete');
    if (userId) { try { await publishAppHome(client, userId); } catch (e) {} }
  } catch (err) { console.error('File error:', err.message); }
});

// ─── SCHEDULER ────────────────────────────────────────────
function startScheduler(client) {
  // 24hr post-upload follow-up
  const checkReminders = async () => {
    try {
      const now = new Date(); let changed = false;
      for (const userId of Object.keys(global.pendingReminders)) {
        for (const rem of global.pendingReminders[userId]) {
          if (rem.sent || new Date(rem.remindAt) > now) continue;
          rem.sent = true; changed = true;
          console.log(`📬 Reminder → ${userId} for "${rem.filename}"`);
          await client.chat.postMessage({
            channel: userId, ...reply([
              header('🎛️ Wavmind Check-in'),
              section(`You uploaded *"${rem.filename}"* yesterday. Want fresh feedback or to compare it against a reference?`),
              actions([btn('🎚️ Get Feedback', 'quick_feedback', 'primary'), btn('🆚 Compare', 'quick_compare')]),
            ], 'Wavmind check-in'),
          });
        }
      }
      if (changed) saveFile(REMINDERS_FILE, global.pendingReminders, 'reminders');
    } catch (err) { console.error('Reminder error:', err.message); }
  };

  // Daily project session reminders ("your recording session is due in 2 days")
  const checkDailyProjects = async () => {
    try {
      const today = todayStr();
      for (const userId of Object.keys(global.userProjects)) {
        for (const project of (global.userProjects[userId] || [])) {
          if (project.completed) continue;
          if (project.lastDailyReminder === today) continue;
          const lines = [];
          for (const key of SESSION_KEYS) {
            const s = project.sessions[key];
            if (s.done || !s.deadline) continue;
            const days = daysUntil(s.deadline);
            if (days <= 7) lines.push(`${deadlineEmoji(days)} *${sessionLabel(key)}* — ${daysPhrase(days)}`);
          }
          if (!lines.length) continue;
          project.lastDailyReminder = today;
          saveProjects();
          const soonest = Math.min(...SESSION_KEYS.filter(k => !project.sessions[k].done && project.sessions[k].deadline).map(k => daysUntil(project.sessions[k].deadline)));
          const tip = await askAI(`A producer's "${project.name}" has a session ${daysPhrase(soonest)}. One short motivating tip to keep momentum. Under 30 words.`);
          console.log(`📅 Daily project reminder → ${userId} "${project.name}"`);
          await client.chat.postMessage({
            channel: userId, ...reply([
              header(`📋 ${project.name} — Daily Check-in`),
              section(`Here\'s what\'s coming up:\n${lines.join('\n')}`),
              divider(),
              section(`🤖 ${tip || 'Keep the momentum going!'}`),
              context('Mark done: type `done mixing` · View: `show project`'),
            ], 'Project reminder'),
          });
        }
      }
    } catch (err) { console.error('Daily project error:', err.message); }
  };

  // Daily new-release alerts by genre
  const checkReleases = async () => {
    try {
      const today = todayStr();
      for (const userId of Object.keys(global.userPrefs)) {
        const p = global.userPrefs[userId];
        if (!p?.releasesEnabled || !p.genre) continue;
        if (p.lastReleaseReminder === today) continue;
        const releases = await getNewReleasesByGenre(p.genre, 5);
        if (!releases || !releases.length) continue;
        p.lastReleaseReminder = today; savePrefs();
        const lines = releases.map(r => `• *<${r.url}|${r.name}>* — ${r.artist} _(${r.date})_`).join('\n');
        await client.chat.postMessage({ channel: userId, ...reply([header(`🎵 New ${p.genre} Releases`), section(lines), context('🤖 Daily drops · type `set genre [x]` to change')], 'New releases') });
      }
    } catch (err) { console.error('Releases error:', err.message); }
  };

  // Daily DAW lessons
  const checkLessons = async () => {
    try {
      const today = todayStr();
      for (const userId of Object.keys(global.userPrefs)) {
        const p = global.userPrefs[userId];
        if (!p?.dawLessonsEnabled || !p.daw) continue;
        if (p.lastLessonReminder === today) continue;
        p.lastLessonReminder = today; savePrefs();
        const lesson = await askAI(`Daily micro-lesson for a ${p.skillLevel || 'beginner'} ${p.daw} producer. One specific technique with 3-4 concrete steps. Vary the topic. Under 130 words.`);
        await client.chat.postMessage({ channel: userId, ...reply([header(`🎓 Today's ${p.daw} Lesson`), section(lesson || 'Lesson unavailable today.'), context(`Level: ${p.skillLevel} · type \`stop lessons\` to pause`)], 'DAW lesson') });
      }
    } catch (err) { console.error('Lessons error:', err.message); }
  };

  checkReminders(); setInterval(checkReminders, 5 * 60 * 1000);
  checkDailyProjects(); setInterval(checkDailyProjects, 60 * 60 * 1000);
  checkReleases(); setInterval(checkReleases, 6 * 60 * 60 * 1000);
  checkLessons(); setInterval(checkLessons, 6 * 60 * 60 * 1000);
  console.log('⏰ Scheduler: 24h reminders, daily project/release/lesson alerts');
}

// ─── MCP SERVER ───────────────────────────────────────────
function startMCPServer() {
  const mcpTools = [
    { name: 'search_samples', description: 'Search 500K+ free Creative Commons samples from Freesound' },
    { name: 'get_track_features', description: 'Get real Spotify audio features for any track' },
    { name: 'analyze_mix', description: 'Get AI mixing feedback from a description' },
    { name: 'get_daw_help', description: 'DAW tutorials via Tavily + AI' },
    { name: 'compare_artists', description: 'Compare two artists via Spotify data' },
    { name: 'new_releases', description: 'Get latest releases for a genre' },
  ];
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        if (req.url === '/health') { res.writeHead(200); res.end(JSON.stringify({ status: 'ok', service: 'Wavmind AI Producer Agent', version: '2.0.0', tools: mcpTools.map(t => t.name) })); return; }
        if (req.url === '/mcp') { res.writeHead(200); res.end(JSON.stringify({ name: 'wavmind', version: '2.0.0', description: 'AI tools for music producers', tools: mcpTools })); return; }
        if (req.url === '/mcp/tools') { res.writeHead(200); res.end(JSON.stringify({ tools: mcpTools })); return; }
        if (req.method === 'POST' && req.url === '/mcp/execute') {
          const { tool, arguments: args } = JSON.parse(body);
          let result;
          switch (tool) {
            case 'search_samples': result = await searchFreesound(args.query); break;
            case 'get_track_features': result = await getTrackFeatures(args.track_name); break;
            case 'analyze_mix': result = await askAI(`Mix feedback: ${args.description}.`); break;
            case 'get_daw_help': { const [t, a] = await Promise.all([tavilySearch(`${args.daw} ${args.question}`), askAI(`${args.daw} tutorial: "${args.question}"`)]); result = { ai_answer: a, web_answer: t?.answer }; break; }
            case 'compare_artists': { const [s1, s2] = await Promise.all([getArtistStats(args.artist1), getArtistStats(args.artist2)]); result = { artist1: s1, artist2: s2 }; break; }
            case 'new_releases': result = await getNewReleasesByGenre(args.genre); break;
            default: result = { error: `Unknown tool: ${tool}` };
          }
          res.writeHead(200); res.end(JSON.stringify({ tool, result })); return;
        }
        res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
      } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); }
    });
  });
  const port = process.env.PORT || 8000;
  server.listen(port, () => console.log(`🔌 MCP Server on port ${port}`));
}

// ─── SLASH COMMAND (mirrors conversational features) ──────
app.command('/wavmind', async ({ command, ack, respond, client }) => {
  await ack();
  const input = command.text.trim();
  const lower = input.toLowerCase();
  const userId = command.user_id;
  const send = async (blocks, t) => respond(reply(blocks, t));

  if (!input || lower === 'help' || lower === 'menu') { await send(getWelcomeBlocks(), 'Welcome'); return; }

  if (/^(start|new)\s*project/.test(lower)) {
    const name = input.replace(/^(start|new)\s*project/i, '').trim();
    if (name) { const p = createProject(userId, name); await send(deadlinePromptBlocks(p), 'Project created'); await publishAppHome(client, userId); }
    else { global.userFlow[userId] = { state: 'awaiting_project_name' }; await send([header('📋 New Project'), section('DM me the project name to continue (or `/wavmind start project My EP`).')], 'Name your project'); }
    return;
  }
  if (lower === 'project' || lower === 'show project') {
    const project = getActiveProject(userId);
    await send(project ? buildProjectBlocks(project) : [header('📋 No Active Project'), section('Type `/wavmind start project My EP`')], 'Project');
    return;
  }
  const dl = lower.match(/^(recording|mixing|mastering|artwork|release|promotion)\s+(.+)$/);
  if (dl) { await handleDeadlineLine(userId, dl[1], dl[2], send, client); return; }
  const doneM = lower.match(/^done\s+(recording|mixing|mastering|artwork|release|promotion)$/);
  if (doneM) { await markDone(userId, doneM[1], send, client); return; }
  if (lower === 'complete project' || lower === 'complete') { await completeActive(userId, send, client); return; }

  if (lower === 'compare') { startCompareSession(userId); await send([header('🆚 Comparison Started'), section('Upload your track, then your reference. I compare loudness, stereo, spectral balance & frequency automatically.'), context('To cancel type `/wavmind cancel`')], 'Compare'); return; }
  if (lower === 'cancel') { clearCompareSession(userId); await send([header('🗑️ Cancelled')], 'Cancelled'); return; }
  if (lower === 'feedback') { await handleFeedback(userId, send); return; }

  if (lower.startsWith('samples') || lower.startsWith('sample')) {
    const q = input.replace(/^samples?\s*/i, '').trim();
    if (!q) { await send([header('🎵 Free Samples'), section('Type: `/wavmind samples drums` · piano · bass · synth · strings · vocal')], 'Samples'); return; }
    await send(await buildSamplesResponse(q, userId), 'Samples'); return;
  }
  if (lower.startsWith('reference')) {
    const q = input.slice(9).trim();
    if (!q) { await send([header('🔍 Reference'), section('Type: `/wavmind reference Tum Hi Ho - Arijit Singh`')], 'Reference'); return; }
    const f = await getTrackFeatures(q);
    if (f) {
      const r = await askAI(`How to achieve the sound of ${f.name} by ${f.artist}: BPM ${f.bpm}, Key ${f.key}, Energy ${f.energy}%, Loudness ${f.loudness}dB. Techniques + real plugins.`);
      await send([header('🎵 Reference Analysis'), section(`*${f.name}* by *${f.artist}*`), twoCol(`🥁 *BPM*\n${f.bpm}`, `🎵 *Key*\n${f.key}`), twoCol(`⚡ *Energy*\n${scoreBar(f.energy)}`, `🔊 *Loudness*\n${f.loudness} dB`), divider(), section(r || 'Error')], 'Reference');
    } else await send([header('🎵 Not Found'), section('Try format: `Song - Artist`')], 'Not found');
    return;
  }
  if (lower.startsWith('artist')) {
    const artists = input.slice(6).trim();
    if (!artists) { await send([header('🎤 Artist Comparison'), section('Type: `/wavmind artist Drake and Travis Scott`')], 'Artists'); return; }
    let a1, a2;
    if (/\sand\s/i.test(artists)) [a1, a2] = artists.split(/\s+and\s+/i);
    else if (/\svs\s/i.test(artists)) [a1, a2] = artists.split(/\s+vs\s+/i);
    else { const w = artists.split(' '); const m = Math.ceil(w.length / 2); a1 = w.slice(0, m).join(' '); a2 = w.slice(m).join(' '); }
    const [s1, s2] = await Promise.all([getArtistStats(a1.trim()), getArtistStats(a2.trim())]);
    if (!s1 || !s2) { await send([header('❗ Not Found')], 'Not found'); return; }
    const ai = await askAI(`Compare ${s1.name} (BPM ${s1.bpm}, Energy ${s1.energy}%) vs ${s2.name} (BPM ${s2.bpm}, Energy ${s2.energy}%). Differences + how to blend.`);
    await send([header('🎤 Artist Comparison'), twoCol(`*${s1.name}*\n🥁 ${s1.bpm} · ⚡ ${s1.energy}%`, `*${s2.name}*\n🥁 ${s2.bpm} · ⚡ ${s2.energy}%`), divider(), section(ai || 'Error')], 'Artists');
    return;
  }
  if (lower.startsWith('daw')) {
    const q = input.slice(3).trim();
    if (!q) { await send([header('🎹 DAW Help'), section('Type: `/wavmind daw fl studio sidechain 808`\n\nFor daily lessons, DM me "teach me fl studio"')], 'DAW'); return; }
    const [tav, ai] = await Promise.all([tavilySearch(`${q} tutorial step by step`), askAI(`Expert DAW instructor. Answer: "${q}". Numbered steps.`)]);
    const blocks = [header('🎹 DAW Help'), section(ai || 'Error')];
    if (tav?.answer) blocks.push(divider(), section('🌐 *Web:* ' + tav.answer));
    await send(blocks, 'DAW help'); return;
  }
  if (/^new release|^releases|^set genre/.test(lower)) {
    if (lower.startsWith('set genre')) { const g = input.replace(/^set genre/i, '').trim(); if (g) { const p = getPrefs(userId); p.genre = g; p.releasesEnabled = true; savePrefs(); await send([header('🎵 Genre set ✅'), section(`Tracking *${g}*`)], 'Genre set'); return; } }
    const p = getPrefs(userId);
    if (!p.genre) { await send([header('🎵 New Releases'), section('Set your genre first: `/wavmind set genre trap`')], 'Set genre'); return; }
    await sendReleases(userId, send); return;
  }
  if (lower.startsWith('ideas')) { const g = input.slice(5).trim() || 'general'; const r = await askAI(`5 track ideas for "${g}". 🎵 *Title* — concept.`); await send([header('🎵 Track Ideas'), section(r || 'Error')], 'Ideas'); return; }
  if (lower.startsWith('chords')) { const q = input.slice(6).trim() || 'C minor'; const r = await askAI(`3 chord progressions for "${q}". Chords, Roman numerals, feel.`); await send([header('🎹 Chords'), section(r || 'Error')], 'Chords'); return; }
  if (lower === 'mcp') { const base = `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'your-url.railway.app'}`; await send([header('🔌 MCP Server'), section(`${base}/health\n${base}/mcp/tools\n${base}/mcp/execute (POST)`), context('Compatible with Claude, GPT & any MCP client')], 'MCP'); return; }

  const r = await askAI(`You are Wavmind, expert AI for music producers. Answer: "${input}"`);
  await send([header('🎛️ Wavmind'), section(r || 'Error'), context('Type `/wavmind help` for all features')], 'Wavmind');
});

// ─── START ────────────────────────────────────────────────
(async () => {
  await app.start();
  console.log('🎛️ Wavmind Agent is running!');
  startMCPServer();
  startScheduler(app.client);
})();
