require('dotenv').config();
const { App } = require('@slack/bolt');
const Groq = require('groq-sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const http = require('http');

// ─── CRASH PROTECTION ─────────────────────────────────────
// Fixes "Unhandled event 'server explicit disconnect'" that killed old version
process.on('uncaughtException', (err) => {
  console.error('uncaughtException (kept alive):', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection (kept alive):', reason?.message || reason);
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

app.error(async (error) => {
  console.error('Bolt error (kept alive):', error?.message || error);
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── PERSISTENT STORAGE ───────────────────────────────────
const REMINDERS_FILE = '/tmp/wavmind_reminders.json';
const STATS_FILE     = '/tmp/wavmind_stats.json';
const DAW_GURU_FILE     = '/tmp/wavmind_dawguru.json';
const PROJECTS_FILE    = '/tmp/wavmind_projects.json';

function loadProjects() {
  try { if (fs.existsSync(PROJECTS_FILE)) return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')); }
  catch (e) { console.error('Load projects:', e.message); }
  return {};
}
function saveProjects(data) {
  try { fs.writeFileSync(PROJECTS_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('Save projects:', e.message); }
}

function loadDawGuru() {
  try { if (fs.existsSync(DAW_GURU_FILE)) return JSON.parse(fs.readFileSync(DAW_GURU_FILE, 'utf8')); }
  catch (e) { console.error('Load DAW Guru:', e.message); }
  return {};
}
function saveDawGuru(data) {
  try { fs.writeFileSync(DAW_GURU_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('Save DAW Guru:', e.message); }
}

function loadReminders() {
  try { if (fs.existsSync(REMINDERS_FILE)) return JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8')); }
  catch (e) { console.error('Load reminders:', e.message); }
  return {};
}
function saveReminders(data) {
  try { fs.writeFileSync(REMINDERS_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('Save reminders:', e.message); }
}
function loadStats() {
  try { if (fs.existsSync(STATS_FILE)) return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); }
  catch (e) { console.error('Load stats:', e.message); }
  return {};
}
function saveStats(data) {
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.error('Save stats:', e.message); }
}

global.pendingReminders = loadReminders();
global.weeklyStats      = loadStats();
global.dawGuruProfiles  = loadDawGuru();
global.userProjects     = loadProjects();
global.userUploads      = global.userUploads || {};
global.samplePageTracker = global.samplePageTracker || {};

function trackUpload(userId, filename, analysis) {
  // Save reminder due in 24 hours
  if (!global.pendingReminders[userId]) global.pendingReminders[userId] = [];
  global.pendingReminders[userId].push({
    filename, analysis,
    uploadedAt: new Date().toISOString(),
    remindAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    sent: false,
  });
  saveReminders(global.pendingReminders);
  // Track for home tab
  if (!global.userUploads[userId]) global.userUploads[userId] = [];
  global.userUploads[userId].push({ filename, analysis, timestamp: new Date().toISOString() });
  // Weekly stats
  if (!global.weeklyStats[userId]) global.weeklyStats[userId] = { tracks: 0, issues: [] };
  global.weeklyStats[userId].tracks++;
  const bass = analysis.bass_ratio || analysis.low_pct || 0;
  if (analysis.energy < 50) global.weeklyStats[userId].issues.push('Low energy');
  if (bass > 65) global.weeklyStats[userId].issues.push('Heavy bass');
  if (bass < 20) global.weeklyStats[userId].issues.push('Thin bass');
  saveStats(global.weeklyStats);
}

// ─── BLOCK KIT HELPERS ────────────────────────────────────
const divider = () => ({ type: 'divider' });
const header  = t => ({ type: 'header', text: { type: 'plain_text', text: t, emoji: true } });
const section = t => ({ type: 'section', text: { type: 'mrkdwn', text: t } });
// Safe twoCol — never passes empty string (prevents Slack invalid_arguments crash)
const twoCol  = (l, r) => ({ type: 'section', fields: [
  { type: 'mrkdwn', text: l || '—' },
  { type: 'mrkdwn', text: r || '—' },
]});
const ctx     = t => ({ type: 'context', elements: [{ type: 'mrkdwn', text: t }] });
const btn     = (text, actionId, style) => {
  const b = { type: 'button', text: { type: 'plain_text', text, emoji: true }, action_id: actionId };
  if (style) b.style = style;
  return b;
};
const actions = btns => ({ type: 'actions', elements: btns });

// ─── LOUDNESS HELPERS ─────────────────────────────────────
function vocalClarityLabel(vc) {
  if (vc === undefined || vc === null) return '—';
  if (vc >= 75) return `${vc}% — Very clear vocals ✅`;
  if (vc >= 55) return `${vc}% — Good vocal presence ✅`;
  if (vc >= 35) return `${vc}% — Moderate vocal clarity`;
  if (vc >= 15) return `${vc}% — Vocals need presence boost`;
  return `${vc}% — Very low vocal clarity`;
}

function freqLabel(low, mid, high) {
  const issues = [];
  if (low > 60) issues.push('🔴 Bass-heavy');
  else if (low < 20) issues.push('🔵 Thin bass');
  else issues.push('✅ Bass OK');
  if (mid < 35) issues.push('🔴 Hollow mids');
  else if (mid > 65) issues.push('⚠️ Muddy mids');
  else issues.push('✅ Mids OK');
  if (high < 5) issues.push('🔴 Dull/dark');
  else if (high > 25) issues.push('⚠️ Harsh highs');
  else issues.push('✅ Highs OK');
  return issues.join(' · ');
}

function loudnessLabel(lufs) {
  if (lufs === undefined || lufs === null) return '— LUFS';
  if (lufs > -7)  return `${lufs} LUFS — very loud / over-compressed`;
  if (lufs > -11) return `${lufs} LUFS — loud, club/master level`;
  if (lufs >= -15) return `${lufs} LUFS — streaming-ready ✅`;
  if (lufs >= -20) return `${lufs} LUFS — a bit quiet`;
  return `${lufs} LUFS — needs mastering`;
}

// ─── GROQ AI ──────────────────────────────────────────────
async function askAI(prompt) {
  try {
    const r = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: 'You are Wavmind, expert AI for music producers. Format using Slack mrkdwn. Use *bold*, • bullets. Never use ** or # headers.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 1024,
    });
    let t = r.choices[0].message.content;
    t = t.replace(/#{1,6}\s+/g, '').replace(/\*\*([^*]+)\*\*/g, '*$1*').replace(/^-\s+/gm, '• ');
    return t;
  } catch (e) { console.error('Groq:', e.message); return null; }
}

// ─── TAVILY ───────────────────────────────────────────────
async function tavilySearch(query) {
  try {
    const r = await axios.post('https://api.tavily.com/search',
      { api_key: process.env.TAVILY_API_KEY, query, search_depth: 'basic', max_results: 5, include_answer: true },
      { timeout: 10000 });
    return { answer: r.data.answer || null, results: (r.data.results || []).map(x => ({ title: x.title, url: x.url })) };
  } catch (e) { console.error('Tavily:', e.message); return null; }
}

// ─── FREESOUND ────────────────────────────────────────────
const ENHANCE = {
  piano: ['piano melody', 'piano chord', 'piano loop', 'piano riff'],
  synth: ['synth pad', 'synth lead', 'synth arp', 'synthesizer'],
  bass: ['bass line', 'bass riff', '808 bass', 'sub bass'],
  guitar: ['guitar riff', 'electric guitar', 'acoustic guitar'],
  drums: ['drum loop', 'drum beat', 'trap drums', 'drum kit'],
  strings: ['string ensemble', 'violin', 'cello', 'orchestral strings'],
  flute: ['flute melody', 'pan flute', 'flute loop'],
  vocal: ['vocal chop', 'vocal sample', 'vocal melody'],
  ambient: ['ambient pad', 'ambient texture', 'ambient drone'],
  trumpet: ['trumpet melody', 'brass', 'trumpet loop'],
  saxophone: ['sax melody', 'saxophone jazz', 'alto sax'],
};
function enhanceQuery(q) {
  const l = q.toLowerCase();
  for (const [k, opts] of Object.entries(ENHANCE)) {
    if (l.includes(k)) return opts[Math.floor(Math.random() * opts.length)];
  }
  return q;
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
    const clean = query.replace(/\b(loop|loops|sample|samples|pack|packs|free|download|audio)\b/gi, '').replace(/\s+/g, ' ').trim() || query;
    const enhanced = enhanceQuery(clean);
    const page = userId ? getNextPage(userId, query) : Math.floor(Math.random() * 8) + 1;
    const base = `https://freesound.org/apiv2/search/text/?token=${process.env.FREESOUND_API_KEY}&format=json&page_size=10&fields=id,name,tags,duration,license,username,previews,avg_rating,num_downloads&filter=duration:[1+TO+30]`;
    const r = await axios.get(`${base}&query=${encodeURIComponent(enhanced)}&page=${page}`, { timeout: 10000 });
    let results = r.data.results || [];
    if (!results.length && page > 1) {
      const fb = await axios.get(`${base}&query=${encodeURIComponent(clean)}&page=1`, { timeout: 10000 });
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
  } catch (e) { console.error('Freesound:', e.message); return null; }
}

// ─── SPOTIFY ──────────────────────────────────────────────
async function getSpotifyToken() {
  const r = await axios.post('https://accounts.spotify.com/api/token', 'grant_type=client_credentials', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET).toString('base64') },
  });
  return r.data.access_token;
}
async function getTrackFeatures(trackName) {
  try {
    const token = await getSpotifyToken();
    const q = trackName.trim().replace(/\s+/g, ' ');
    let sr = await axios.get('https://api.spotify.com/v1/search', { headers: { Authorization: `Bearer ${token}` }, params: { q, type: 'track', limit: 1, market: 'US' } });
    let track = sr.data.tracks.items[0];
    if (!track) {
      const simple = q.split(/[-–]|by/i)[0].trim();
      sr = await axios.get('https://api.spotify.com/v1/search', { headers: { Authorization: `Bearer ${token}` }, params: { q: simple, type: 'track', limit: 1, market: 'US' } });
      track = sr.data.tracks.items[0];
      if (!track) return null;
    }
    const f = await axios.get(`https://api.spotify.com/v1/audio-features/${track.id}`, { headers: { Authorization: `Bearer ${token}` } });
    const keys = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    return { name: track.name, artist: track.artists[0].name, bpm: Math.round(f.data.tempo), key: keys[f.data.key] + ' ' + ['Minor','Major'][f.data.mode], energy: Math.round(f.data.energy * 100), danceability: Math.round(f.data.danceability * 100), loudness: f.data.loudness.toFixed(1), valence: Math.round(f.data.valence * 100) };
  } catch (e) { console.error('Spotify track:', e.message); return null; }
}
async function getArtistStats(name) {
  try {
    const token = await getSpotifyToken();
    const sr = await axios.get('https://api.spotify.com/v1/search', { headers: { Authorization: `Bearer ${token}` }, params: { q: name, type: 'track', limit: 5 } });
    const tracks = sr.data.tracks.items;
    if (!tracks.length) return null;
    const fRes = await Promise.all(tracks.map(t => axios.get(`https://api.spotify.com/v1/audio-features/${t.id}`, { headers: { Authorization: `Bearer ${token}` } })));
    const feats = fRes.map(r => r.data);
    const avg = k => Math.round(feats.reduce((s, f) => s + f[k], 0) / feats.length);
    const keys = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    return { name, bpm: avg('tempo'), energy: Math.round(avg('energy')), danceability: Math.round(avg('danceability')), valence: Math.round(avg('valence')), loudness: (feats.reduce((s,f)=>s+f.loudness,0)/feats.length).toFixed(1), key: keys[Math.abs(avg('key'))%12]+' '+['Minor','Major'][avg('mode')>0?1:0] };
  } catch (e) { console.error('Spotify artist:', e.message); return null; }
}

// ─── SPOTIFY NEW RELEASES ─────────────────────────────────
async function getNewReleases(genre) {
  try {
    const token = await getSpotifyToken();
    const year = new Date().getFullYear();
    const q = genre ? `${genre} year:${year}` : `year:${year} tag:new`;
    const r = await axios.get('https://api.spotify.com/v1/search', {
      headers: { Authorization: `Bearer ${token}` },
      params: { q, type: 'track', limit: 10, market: 'US' },
    });
    const tracks = r.data.tracks?.items || [];
    if (!tracks.length) {
      // fallback: search for popular recent music
      const fb = await axios.get('https://api.spotify.com/v1/search', {
        headers: { Authorization: `Bearer ${token}` },
        params: { q: genre || 'new music 2025', type: 'track', limit: 10, market: 'US' },
      });
      return (fb.data.tracks?.items || []).slice(0, 8).map(t => ({
        name: t.name,
        artist: t.artists.map(x => x.name).join(', '),
        album: t.album?.name || '',
        releaseDate: t.album?.release_date || '',
        url: t.external_urls?.spotify || '',
        popularity: t.popularity || 0,
      }));
    }
    return tracks.slice(0, 8).map(t => ({
      name: t.name,
      artist: t.artists.map(x => x.name).join(', '),
      album: t.album?.name || '',
      releaseDate: t.album?.release_date || '',
      url: t.external_urls?.spotify || '',
      popularity: t.popularity || 0,
    }));
  } catch (e) { console.error('New releases:', e.message); return null; }
}

async function searchNewReleasesByGenre(genre) {
  return getNewReleases(genre);
}

// ─── DAW GURU ─────────────────────────────────────────────
const DAW_LEVELS = {
  beginner:     { label: 'Beginner', emoji: '🌱', desc: 'Learning the basics' },
  intermediate: { label: 'Intermediate', emoji: '🎚️', desc: 'Building real skills' },
  advanced:     { label: 'Advanced', emoji: '🔥', desc: 'Pro techniques' },
  professional: { label: 'Professional', emoji: '🏆', desc: 'Studio-level work' },
};
const DAW_LIST_NAMES = ['FL Studio','Ableton Live','Logic Pro','Pro Tools','Cubase','Studio One','GarageBand','Reaper','Bitwig'];

async function getDawGuruTip(daw, level, focus = null) {
  const levelInfo = DAW_LEVELS[level] || DAW_LEVELS.intermediate;
  const prompt = `You are a ${daw} expert giving a daily tip to a ${levelInfo.label} producer.
${focus ? `Their focus area: ${focus}` : ''}
Give ONE specific, actionable tip they can apply today in ${daw}.
Format: 🎛️ *Tip Title* — then 2-3 sentences explaining exactly what to do with specific menu names, shortcut keys, or plugin settings.
Keep it practical and doable in under 10 minutes.`;
  return await askAI(prompt);
}

// ─── AUDIO ANALYSIS ───────────────────────────────────────
async function analyzeAudioFile(fileUrl, filename) {
  const fp = path.join('/tmp', filename.replace(/[^a-zA-Z0-9._-]/g, '_'));
  try {
    const r = await axios.get(fileUrl, { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }, responseType: 'arraybuffer', timeout: 30000 });
    fs.writeFileSync(fp, r.data);
    const result = spawnSync('python3', ['analyze.py', fp], { timeout: 90000, encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || 'analyze.py failed');
    const out = result.stdout.trim();
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    const a = JSON.parse(out);
    if (a.error) { console.error('analyze.py error:', a.error); return { error: a.error }; }
    return a;
  } catch (e) {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    console.error('analyzeAudioFile:', e.message);
    return { error: e.message };
  }
}

// ─── SESSIONS ─────────────────────────────────────────────
global.compareSessions = global.compareSessions || {};
const getCompareSession   = id => global.compareSessions[id] || null;
const startCompareSession = id => { global.compareSessions[id] = { status: 'waiting_your_track', yourTrack: null, referenceTrack: null }; return global.compareSessions[id]; };
const clearCompareSession = id => { delete global.compareSessions[id]; };

global.collabSessions = global.collabSessions || {};
const getCollabSession   = id => global.collabSessions[id] || null;
const startCollabSession = (ch, name, uid) => { global.collabSessions[ch] = { trackName: name, startedBy: uid, startedAt: new Date().toISOString(), ideas: [], feedback: [], decisions: [] }; return global.collabSessions[ch]; };
const endCollabSession   = id => { const s = global.collabSessions[id]; delete global.collabSessions[id]; return s; };

// ─── WELCOME / MENU BLOCKS ────────────────────────────────
function getWelcomeBlocks() {
  return [
    header('🎛️ Hey! I\'m Wavmind 👋'),
    section('Your AI music production agent inside Slack.\n\n*What do you want to do?*'),
    divider(),
    actions([btn('🎵 Analyze My Music', 'menu_analyze', 'primary'), btn('🎹 Make Music', 'menu_create')]),
    actions([btn('🎚️ Get Feedback', 'menu_feedback'), btn('🤝 Team Session', 'menu_collab')]),
    divider(),
    ctx('💡 Or just type `/wavmind` + what you need · `/wavmind compare` · `/wavmind samples piano` · `/wavmind daw fl studio sidechain`'),
  ];
}
function getAnalyzeBlocks() {
  return [
    header('🔬 Analyze Your Music'),
    divider(),
    section('*🆚 Compare Your Track vs Reference*\nUpload your beat + a reference song → get a side-by-side gap report\n\n`/wavmind compare`'),
    section('*🔍 Analyze Any Song*\nReal Spotify data + production blueprint for any track\n\n`/wavmind reference Blinding Lights - The Weeknd`'),
    section('*🎛️ Quick Audio Scan*\nJust upload any MP3 or WAV — Wavmind scans it automatically\n\n_LUFS loudness · Stereo width · Low/Mid/High balance · Vocal clarity_'),
    divider(),
    actions([btn('← Back', 'menu_main')]),
  ];
}
function getCreateBlocks() {
  return [
    header('🎹 Make Music'),
    divider(),
    section('*🎵 Free Samples*\nDifferent results every time!\n\n`/wavmind samples drums` · `/wavmind samples piano`\n`/wavmind samples bass` · `/wavmind samples synth`'),
    section('*💡 Track Ideas*\n`/wavmind ideas dark trap`\n`/wavmind ideas lo-fi chill`'),
    section('*🎹 Chord Progressions*\n`/wavmind chords F minor trap`\n`/wavmind chords C major pop`'),
    section('*🥁 BPM & Key*\n`/wavmind bpm dark hip hop`'),
    section('*🎸 DAW Help*\n`/wavmind daw fl studio sidechain 808`\n`/wavmind daw ableton warp audio`\n`/wavmind daw logic pro flex pitch`'),
    divider(),
    actions([btn('← Back', 'menu_main')]),
  ];
}
function getFeedbackBlocks() {
  return [
    header('🎚️ Get Feedback'),
    divider(),
    section('*🎚️ Mix Feedback*\n`/wavmind feedback my trap beat at 140bpm feels muddy`'),
    section('*🎛️ Deep Mix Analysis*\nUpload your audio first, then:\n`/wavmind feedback bpm:140 key:F_minor`'),
    section('*🎯 Label Evaluation*\n`/wavmind label dark trap 140bpm heavy 808s`'),
    section('*🎤 Artist Comparison*\n`/wavmind artist Drake and Travis Scott`'),
    divider(),
    actions([btn('← Back', 'menu_main')]),
  ];
}
function getCollabBlocks() {
  return [
    header('🤝 Team Session'),
    divider(),
    section('`/wavmind collab Dark Trap EP` — Start\n`/wavmind idea [idea]` — Log idea\n`/wavmind note [feedback]` — Log note\n`/wavmind decided [decision]` — Log decision\n`/wavmind summary` — AI summary\n`/wavmind end` — End session'),
    divider(),
    actions([btn('← Back', 'menu_main')]),
  ];
}

// ─── BUTTON HANDLERS ──────────────────────────────────────
app.action('menu_main',     async ({ body, ack, client }) => { await ack(); await client.chat.postMessage({ channel: body.user.id, text: 'Wavmind', blocks: getWelcomeBlocks() }); });
app.action('menu_analyze',  async ({ body, ack, client }) => { await ack(); await client.chat.postMessage({ channel: body.user.id, text: 'Analyze', blocks: getAnalyzeBlocks() }); });
app.action('menu_create',   async ({ body, ack, client }) => { await ack(); await client.chat.postMessage({ channel: body.user.id, text: 'Create', blocks: getCreateBlocks() }); });
app.action('menu_feedback', async ({ body, ack, client }) => { await ack(); await client.chat.postMessage({ channel: body.user.id, text: 'Feedback', blocks: getFeedbackBlocks() }); });
app.action('menu_collab',   async ({ body, ack, client }) => { await ack(); await client.chat.postMessage({ channel: body.user.id, text: 'Collab', blocks: getCollabBlocks() }); });
app.action('quick_compare', async ({ body, ack, client }) => {
  await ack();
  startCompareSession(body.user.id);
  await client.chat.postMessage({ channel: body.user.id, text: 'Comparison started', blocks: [header('🆚 Comparison Started!'), section('*Step 1* — Upload YOUR track\n*Step 2* — Upload your REFERENCE track\n\nWavmind compares automatically.'), ctx('Cancel: `/wavmind cancel`')] });
});
app.action('quick_feedback', async ({ body, ack, client }) => {
  await ack();
  await client.chat.postMessage({ channel: body.user.id, text: 'Feedback', blocks: [
    header('🎚️ Get Mix Feedback'),
    section('*If you just uploaded audio:*\nType `/wavmind feedback` — Wavmind uses your scan data automatically.\n\n*No upload yet?*\nType `/wavmind feedback` + describe your mix:\n`/wavmind feedback my trap beat feels muddy and lacks punch`'),
    ctx('💡 Upload audio first for feedback based on real measurements'),
  ]});
});

// ─── DAW GURU BUTTON HANDLERS ────────────────────────────
// DAW selection buttons
const DAW_BUTTONS = ['FL Studio','Ableton Live','Logic Pro','Pro Tools','Cubase','Studio One','GarageBand','Reaper','Bitwig'];
const LEVEL_BUTTONS = ['beginner','intermediate','advanced','professional'];
const FOCUS_BUTTONS = ['Mixing','Sound Design','Arrangement','Beat Making','Mastering','Melody Writing','Bass Design','General'];

function getGuruDAWBlocks() {
  return [
    header('🎓 Welcome to DAW Guru!'),
    section('Your personal AI music tutor. Get *daily lessons* tailored to your DAW and skill level — sent to your DMs every morning automatically.\n\n*Step 1 — Which DAW do you use?*'),
    divider(),
    actions(DAW_BUTTONS.slice(0,4).map(d => btn(d, `guru_daw_${d.toLowerCase().replace(/ /g,'_')}`))),
    actions(DAW_BUTTONS.slice(4).map(d => btn(d, `guru_daw_${d.toLowerCase().replace(/ /g,'_')}`))),
    ctx('🎓 Tap your DAW to continue'),
  ];
}

function getGuruLevelBlocks(daw) {
  return [
    header(`🎓 DAW Guru — ${daw} ✅`),
    section('*Step 2 — What\'s your skill level?*'),
    divider(),
    actions([
      btn('🌱 Beginner', 'guru_level_beginner'),
      btn('🎚️ Intermediate', 'guru_level_intermediate'),
    ]),
    actions([
      btn('🔥 Advanced', 'guru_level_advanced'),
      btn('🏆 Professional', 'guru_level_professional'),
    ]),
    ctx('Beginner = learning basics · Intermediate = making beats · Advanced = pro techniques · Professional = studio level'),
  ];
}

function getGuruFocusBlocks(daw, level) {
  const li = DAW_LEVELS[level] || DAW_LEVELS.intermediate;
  return [
    header(`🎓 ${daw} · ${li.emoji} ${li.label} ✅`),
    section('*Step 3 — What\'s your main focus?*\n_This personalizes every lesson you receive_'),
    divider(),
    actions([
      btn('🎚️ Mixing', 'guru_focus_mixing'),
      btn('🎛️ Sound Design', 'guru_focus_sound_design'),
      btn('🎼 Arrangement', 'guru_focus_arrangement'),
      btn('🥁 Beat Making', 'guru_focus_beat_making'),
    ]),
    actions([
      btn('🔊 Mastering', 'guru_focus_mastering'),
      btn('🎹 Melody', 'guru_focus_melody'),
      btn('🎸 Bass Design', 'guru_focus_bass_design'),
      btn('🎵 General', 'guru_focus_general'),
    ]),
  ];
}

function getGuruActiveBlocks(p) {
  const li = DAW_LEVELS[p.level] || DAW_LEVELS.intermediate;
  return [
    header('🎓 DAW Guru — Active'),
    twoCol(`🎛️ *DAW*\n${p.daw}`, `${li.emoji} *Level*\n${li.label}`),
    twoCol(`🎯 *Focus*\n${p.style || 'General'}`, `📖 *Lessons*\n${p.tipsCount || 0} received`),
    divider(),
    actions([
      btn('🎓 Get Lesson Now', 'guru_tip_now', 'primary'),
      btn('⚙️ Change Settings', 'guru_restart'),
      btn('⏸️ Pause', 'guru_stop'),
    ]),
    ctx(`📅 Daily lessons at 9am · Type \`/wavmind guru\` to manage`),
  ];
}

// Register all DAW buttons
DAW_BUTTONS.forEach(daw => {
  const actionId = `guru_daw_${daw.toLowerCase().replace(/ /g,'_')}`;
  app.action(actionId, async ({ body, ack, client }) => {
    await ack();
    const userId = body.user.id;
    if (!global.dawGuruProfiles[userId]) global.dawGuruProfiles[userId] = {};
    global.dawGuruProfiles[userId].daw = daw;
    global.dawGuruProfiles[userId].userId = userId;
    global.dawGuruProfiles[userId].paused = false;
    saveDawGuru(global.dawGuruProfiles);
    await client.chat.postMessage({ channel: userId, text: 'DAW Guru', blocks: getGuruLevelBlocks(daw) });
  });
});

// Register all level buttons
LEVEL_BUTTONS.forEach(level => {
  app.action(`guru_level_${level}`, async ({ body, ack, client }) => {
    await ack();
    const userId = body.user.id;
    if (!global.dawGuruProfiles[userId]) global.dawGuruProfiles[userId] = {};
    global.dawGuruProfiles[userId].level = level;
    saveDawGuru(global.dawGuruProfiles);
    const daw = global.dawGuruProfiles[userId].daw || 'Your DAW';
    await client.chat.postMessage({ channel: userId, text: 'DAW Guru', blocks: getGuruFocusBlocks(daw, level) });
  });
});

// Register all focus buttons
['mixing','sound_design','arrangement','beat_making','mastering','melody','bass_design','general'].forEach(focus => {
  app.action(`guru_focus_${focus}`, async ({ body, ack, client }) => {
    await ack();
    const userId = body.user.id;
    if (!global.dawGuruProfiles[userId]) global.dawGuruProfiles[userId] = {};
    const style = focus.replace(/_/g, ' ');
    global.dawGuruProfiles[userId].style = style;
    saveDawGuru(global.dawGuruProfiles);
    const p = global.dawGuruProfiles[userId];
    const li = DAW_LEVELS[p.level] || DAW_LEVELS.intermediate;
    // Send completion + first tip
    await client.chat.postMessage({ channel: userId, text: 'DAW Guru', blocks: [
      header('🎓 DAW Guru — You\'re All Set! 🎉'),
      twoCol(`🎛️ *DAW*\n${p.daw}`, `${li.emoji} *Level*\n${li.label}`),
      twoCol(`🎯 *Focus*\n${style}`, `📅 *Daily lessons*\nEvery morning at 9am`),
      divider(),
      section('Daily lessons will arrive in your DMs every morning. Get your *first lesson right now:*'),
      actions([btn('🎓 Get First Lesson', 'guru_tip_now', 'primary')]),
    ]});
  });
});

// Tip/lesson now button
app.action('guru_tip_now', async ({ body, ack, client }) => {
  await ack();
  const userId = body.user.id;
  const p = global.dawGuruProfiles[userId];
  if (!p?.daw || !p?.level) {
    await client.chat.postMessage({ channel: userId, text: 'Setup', blocks: getGuruDAWBlocks() });
    return;
  }
  const tip = await getDawGuruTip(p.daw, p.level, p.style);
  const li = DAW_LEVELS[p.level] || DAW_LEVELS.intermediate;
  if (!global.dawGuruProfiles[userId]) global.dawGuruProfiles[userId] = p;
  global.dawGuruProfiles[userId].tipsCount = (p.tipsCount || 0) + 1;
  global.dawGuruProfiles[userId].lastTip = new Date().toISOString();
  saveDawGuru(global.dawGuruProfiles);
  await client.chat.postMessage({ channel: userId, text: 'Lesson', blocks: [
    header(`🎓 ${p.daw} Lesson — ${li.emoji} ${li.label}`),
    ...(p.style && p.style !== 'general' ? [section(`🎯 *Focus: ${p.style}*`)] : []),
    divider(),
    section(tip || 'Could not generate. Try again.'),
    divider(),
    actions([btn('🎓 Another Lesson', 'guru_tip_now'), btn('⚙️ Settings', 'guru_status')]),
    ctx(`📖 Lesson ${global.dawGuruProfiles[userId].tipsCount} · Daily at 9am`),
  ]});
});

// Open guru button (from scan results)
app.action('guru_open', async ({ body, ack, client }) => {
  await ack();
  const userId = body.user.id;
  const p = global.dawGuruProfiles[userId];
  if (!p?.daw || !p?.level) {
    await client.chat.postMessage({ channel: userId, text: 'DAW Guru', blocks: getGuruDAWBlocks() });
  } else {
    await client.chat.postMessage({ channel: userId, text: 'DAW Guru', blocks: getGuruActiveBlocks(p) });
  }
});

// Pause button
app.action('guru_stop', async ({ body, ack, client }) => {
  await ack();
  const userId = body.user.id;
  if (global.dawGuruProfiles[userId]) { global.dawGuruProfiles[userId].paused = true; saveDawGuru(global.dawGuruProfiles); }
  await client.chat.postMessage({ channel: userId, text: 'Paused', blocks: [
    header('⏸️ DAW Guru Paused'),
    section('Daily lessons stopped.'),
    actions([btn('▶️ Resume', 'guru_resume'), btn('🎓 Get Lesson Now', 'guru_tip_now')]),
  ]});
});

// Resume button
app.action('guru_resume', async ({ body, ack, client }) => {
  await ack();
  const userId = body.user.id;
  if (global.dawGuruProfiles[userId]) { global.dawGuruProfiles[userId].paused = false; saveDawGuru(global.dawGuruProfiles); }
  const p = global.dawGuruProfiles[userId];
  await client.chat.postMessage({ channel: userId, text: 'Resumed', blocks: getGuruActiveBlocks(p || {}) });
});

// Status button
app.action('guru_status', async ({ body, ack, client }) => {
  await ack();
  const userId = body.user.id;
  const p = global.dawGuruProfiles[userId];
  if (!p?.daw || !p?.level) { await client.chat.postMessage({ channel: userId, text: 'Setup', blocks: getGuruDAWBlocks() }); return; }
  await client.chat.postMessage({ channel: userId, text: 'Status', blocks: getGuruActiveBlocks(p) });
});

// Restart/reset button
app.action('guru_restart', async ({ body, ack, client }) => {
  await ack();
  const userId = body.user.id;
  delete global.dawGuruProfiles[userId];
  saveDawGuru(global.dawGuruProfiles);
  await client.chat.postMessage({ channel: userId, text: 'DAW Guru', blocks: getGuruDAWBlocks() });
});

// ─── PROJECT TRACKER BUTTONS ─────────────────────────────
app.action('project_list', async ({ body, ack, client }) => {
  await ack();
  const userId = body.user.id;
  const projects = global.userProjects[userId] || [];
  if (!projects.length) {
    await client.chat.postMessage({ channel: userId, text: 'Projects', blocks: [
      header('🎵 No Projects Yet'),
      section('Start tracking your music projects and get daily reminders.'),
      actions([btn('➕ Add Project', 'project_add_prompt', 'primary')]),
    ]});
    return;
  }
  const bl = [header(`🎵 Your Projects (${projects.length})`), divider()];
  projects.forEach((p, i) => {
    const age = Math.floor((Date.now() - new Date(p.createdAt)) / (1000*60*60*24));
    bl.push(section(`${p.done ? '✅' : '🎵'} *${p.name}*
📅 Day ${age} · ${p.done ? 'Complete' : 'In Progress'}
${p.notes?.slice(-1)[0] ? `📝 _${p.notes.slice(-1)[0].text}_` : ''}`));
  });
  bl.push(divider(), actions([btn('➕ Add Project', 'project_add_prompt', 'primary'), btn('🔄 Refresh', 'project_list')]));
  await client.chat.postMessage({ channel: userId, text: 'Projects', blocks: bl });
});

app.action('project_add_prompt', async ({ body, ack, client }) => {
  await ack();
  const userId = body.user.id;
  await client.chat.postMessage({ channel: userId, text: 'Add Project', blocks: [
    header('➕ Add a Project'),
    section('Type the command with your project name:'),
    section('`/wavmind project add Dark Trap EP`\n`/wavmind project add Summer Vibes Beat`\n`/wavmind project add Collab with Ahmed`'),
    ctx('Wavmind will send daily reminders to keep you on track'),
  ]});
});

// New releases button handlers
app.action('releases_global', async ({ body, ack, client }) => {
  await ack();
  const userId = body.user.id;
  await client.chat.postMessage({ channel: userId, text: 'Fetching...', blocks: [header('🆕 Fetching Latest Releases...'), ctx('⏳')] });
  const releases = await getNewReleases(null);
  if (!releases?.length) { await client.chat.postMessage({ channel: userId, text: 'Error', blocks: [header('❗ Could not fetch'), section('Try again shortly.')] }); return; }
  const bl = [header('🆕 Latest Releases on Spotify'), section(`*${releases.length} fresh tracks*`), divider()];
  releases.forEach((r, i) => {
    bl.push(section(`*${i+1}. ${r.name}*
👤 ${r.artist}${r.album ? `  💿 ${r.album}` : ''}  📅 ${r.releaseDate}  🔥 ${r.popularity}%
🎵 *<${r.url}|▶ Listen on Spotify>*`));
    if (i < releases.length - 1) bl.push(divider());
  });
  bl.push(divider(), actions([
    btn('🎵 Trap', 'releases_trap'), btn('🎵 Pop', 'releases_pop'),
    btn('🎵 R&B', 'releases_rnb'), btn('🔄 Refresh', 'releases_global'),
  ]));
  await client.chat.postMessage({ channel: userId, text: 'New Releases', blocks: bl });
});

['trap','pop','rnb','hiphop','afrobeats','drill'].forEach(genre => {
  app.action(`releases_${genre}`, async ({ body, ack, client }) => {
    await ack();
    const userId = body.user.id;
    await client.chat.postMessage({ channel: userId, text: 'Fetching...', blocks: [header(`🆕 Fetching ${genre} releases...`), ctx('⏳')] });
    const releases = await getNewReleases(genre);
    if (!releases?.length) { await client.chat.postMessage({ channel: userId, text: 'Error', blocks: [header('❗ No results'), section(`No recent ${genre} found.`)] }); return; }
    const bl = [header(`🆕 New ${genre.toUpperCase()} Releases`), divider()];
    releases.forEach((r, i) => {
      bl.push(section(`*${i+1}. ${r.name}*
👤 ${r.artist}  🔥 ${r.popularity}%
🎵 *<${r.url}|▶ Listen>*`));
      if (i < releases.length - 1) bl.push(divider());
    });
    bl.push(divider(), actions([
      btn('🌍 All Genres', 'releases_global'), btn('🔄 More', `releases_${genre}`),
    ]));
    await client.chat.postMessage({ channel: userId, text: 'Releases', blocks: bl });
  });
});

// ─── APP HOME ─────────────────────────────────────────────
async function publishAppHome(client, userId) {
  try {
    const uploads = global.userUploads[userId] || [];
    const last = uploads[uploads.length - 1];
    const stats = global.weeklyStats[userId];
    const blocks = [
      section('*🎛️ Wavmind*\n_Your autonomous AI music production agent_'),
      divider(),
    ];

    if (last?.analysis && !last.analysis.error) {
      const a = last.analysis;
      const hasFull = a.lufs !== undefined;
      blocks.push(header('📊 Your Last Track'));
      blocks.push(section(`🎵 *${last.filename}*`));
      if (hasFull) {
        blocks.push(twoCol(`🔊 *Loudness*\n${loudnessLabel(a.lufs)}`, `🎚️ *Stereo Width*\n${a.stereo_width}%`));
        blocks.push(twoCol(`📊 *Low / Mid / High*\n${a.low_pct}% / ${a.mid_pct}% / ${a.high_pct}%`, `🎤 *Vocal Clarity*\n${a.vocal_clarity}%`));
        blocks.push(twoCol(`⚡ *Energy*\n${a.energy}%`, `🌈 *Brightness*\n${a.brightness}`));
      } else {
        blocks.push(twoCol(`⚡ *Energy*\n${a.energy}%`, `🌈 *Brightness*\n${a.brightness}`));
        blocks.push(twoCol(`🔊 *Bass*\n${a.bass_ratio}%`, `⏱️ *Duration*\n${Math.floor(a.duration/60)}:${String(a.duration%60).padStart(2,'0')}`));
      }
      blocks.push(ctx(`_Scanned ${new Date(last.timestamp).toLocaleDateString()} · Reminder DM in 24hrs_`));
      blocks.push(actions([btn('🆚 Compare with Reference', 'quick_compare', 'primary'), btn('🎚️ Get Feedback', 'quick_feedback')]));
      blocks.push(divider());
    }

    if (stats?.tracks > 0) {
      blocks.push(header('📈 This Week'));
      blocks.push(twoCol(`🎵 *Tracks Scanned*\n${stats.tracks}`, `⚠️ *Top Issue*\n${stats.issues[0] || 'None'}`));
      blocks.push(divider());
    }

    blocks.push(
      header('🎛️ What Can I Do?'),
      twoCol('*🆚 Compare Tracks*\nYour mix vs reference → gap report\n\n`/wavmind compare`', '*🔍 Analyze a Song*\nReal Spotify data + blueprint\n\n`/wavmind reference [song]`'),
      twoCol('*🎵 Free Samples*\nDifferent results every time\n\n`/wavmind samples piano`\n`/wavmind samples drums`', '*🎸 DAW Help*\nStep-by-step tutorials\n\n`/wavmind daw fl studio [q]`'),
      twoCol('*🎚️ Mix Feedback*\nProfessional AI advice\n\n`/wavmind feedback [describe]`', '*🎯 Label Evaluation*\nA&R assessment\n\n`/wavmind label [describe]`'),
      twoCol('*🎤 Artist Comparison*\nSpotify DNA analysis\n\n`/wavmind artist [a] and [b]`', '*🤝 Team Sessions*\nCollaborate on tracks\n\n`/wavmind collab [track name]`'),
      divider(),
      header('🤖 Autonomous Features'),
      section('• *24hr Reminder* — Uploads a track? Wavmind DMs you the next day\n• *Weekly Report* — Every Monday: your production summary\n• *Channel Monitor* — Spots music topics and jumps in with tips\n• *MCP Server* — Any AI agent can connect to Wavmind\'s tools'),
      divider(),
      header('⚡ Powered By'),
      twoCol('🤖 *Groq AI* — Llama 3.1', '🎵 *Spotify* — Real audio data'),
      twoCol('🔍 *Tavily* — Real-time search', '🎵 *Freesound* — 500K+ samples'),
      twoCol('🎧 *Librosa + pyloudnorm* — Deep audio analysis', '🔌 *MCP* — AI agent protocol'),
      divider(),
      ctx('🎛️ *Wavmind* — Type `/wavmind` to get started')
    );

    await client.views.publish({ user_id: userId, view: { type: 'home', blocks } });
  } catch (e) { console.error('Home tab error:', e.message); }
}

app.event('app_home_opened', async ({ event, client }) => {
  await publishAppHome(client, event.user);
});

// ─── CHANNEL MONITORING ───────────────────────────────────
app.message(async ({ message, say }) => {
  if (message.subtype || !message.text) return;
  const lower = message.text.toLowerCase().trim();
  if (['hi','hello','hey','start','help'].includes(lower)) {
    await say({ text: 'Wavmind', blocks: getWelcomeBlocks() });
    return;
  }
  const kws = ['muddy','808','sidechain','compress','reverb','mixing','mastering','plugin','vst','fl studio','ableton','logic pro','melody','chord','bass line','hi-hat','kick','snare','bpm'];
  if (kws.some(k => lower.includes(k)) && !lower.startsWith('/') && Math.random() < 0.33) {
    try {
      const r = await askAI(`Music producer said: "${message.text}". Give a 2-sentence helpful tip. End with one Wavmind command. Be natural.`);
      if (r) await say({ thread_ts: message.ts, text: 'Tip', blocks: [section(`🎛️ *Wavmind:* ${r}`), ctx('Type `/wavmind` for all features')] });
    } catch (e) { console.error('Monitor:', e.message); }
  }
});

// ─── APP MENTION ──────────────────────────────────────────
app.event('app_mention', async ({ event, say }) => {
  const input = event.text.replace(/<@[^>]+>/g, '').trim();
  if (!input) { await say({ text: 'Wavmind', blocks: getWelcomeBlocks() }); return; }
  const r = await askAI(`You are Wavmind, expert AI for music producers. Answer: "${input}"`);
  await say({ text: 'Wavmind', blocks: [section(`<@${event.user}>`), section(r || 'Error'), ctx('Type `/wavmind` for all features')] });
});

// ─── FILE UPLOAD HANDLER ──────────────────────────────────
app.event('file_shared', async ({ event, client }) => {
  try {
    const fi = await client.files.info({ file: event.file_id });
    const file = fi.file;
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['mp3','wav','flac','aac','m4a','ogg'].includes(ext)) return;

    const userId = event.user_id;
    const channelId = event.channel_id;
    const post = (blocks, t) => client.chat.postMessage({ channel: channelId, text: t || 'Wavmind', blocks });
    const cs = userId ? getCompareSession(userId) : null;

    // ── COMPARISON MODE ──────────────────────────────────
    if (cs) {
      if (cs.status === 'waiting_your_track') {
        await post([header('🎵 Scanning Your Track...'), section(`*${file.name}*`), ctx('⏳ Step 1 of 2')], 'Scanning');
        const a = await analyzeAudioFile(file.url_private_download, file.name);
        if (!a || a.error) { await post([header('❗ Scan Failed'), section('Try an MP3 or WAV under ~15MB.')], 'Error'); return; }
        cs.yourTrack = { filename: file.name, ...a };
        cs.status = 'waiting_reference';
        const hasFull = a.lufs !== undefined;
        const bl = [header('✅ Your Track Scanned — Step 1 of 2'), section(`*${file.name}*`), divider()];
        if (hasFull) {
          bl.push(twoCol(`🔊 *Loudness*\n${loudnessLabel(a.lufs)}`, `🎚️ *Stereo*\n${a.stereo_width}%`));
          bl.push(twoCol(`📊 *Low/Mid/High*\n${a.low_pct}/${a.mid_pct}/${a.high_pct}%`, `⚡ *Energy*\n${a.energy}%`));
        } else {
          bl.push(twoCol(`⚡ *Energy*\n${a.energy}%`, `🔊 *Bass*\n${a.bass_ratio}%`));
          bl.push(twoCol(`🌈 *Brightness*\n${a.brightness}`, `⏱️ *Duration*\n${Math.floor(a.duration/60)}:${String(a.duration%60).padStart(2,'0')}`));
        }
        bl.push(divider(), header('🎯 Step 2 — Upload Your Reference Track'), section('Upload the song you want to sound like.'));
        await post(bl, 'Track scanned');

      } else if (cs.status === 'waiting_reference') {
        await post([header('🔍 Scanning Reference...'), section(`*${file.name}*`), ctx('⏳ Generating comparison...')], 'Scanning');
        const a = await analyzeAudioFile(file.url_private_download, file.name);
        if (!a || a.error) { await post([header('❗ Scan Failed'), section('Try an MP3 under ~15MB.')], 'Error'); return; }
        cs.referenceTrack = { filename: file.name, ...a };
        const y = cs.yourTrack, r = cs.referenceTrack;
        clearCompareSession(userId);

        const hasFull = y.lufs !== undefined && r.lufs !== undefined;

        // Build AI prompt with all available data
        const aiPrompt = hasFull
          ? `Professional mastering engineer. Compare and give specific fixes (EQ in Hz, compression, real plugin names).

MY TRACK "${y.filename}": loudness ${y.lufs} LUFS, stereo ${y.stereo_width}%, low/mid/high ${y.low_pct}/${y.mid_pct}/${y.high_pct}%, brightness ${y.spectral_centroid}Hz, energy ${y.energy}%
REFERENCE "${r.filename}": loudness ${r.lufs} LUFS, stereo ${r.stereo_width}%, low/mid/high ${r.low_pct}/${r.mid_pct}/${r.high_pct}%, brightness ${r.spectral_centroid}Hz, energy ${r.energy}%

Give: 1) Loudness fix 2) Spectral/frequency fix 3) Stereo width fix 4) Energy fix. Then "Top 3 moves to match the reference".`
          : `Professional mixing engineer. Compare:
MY TRACK "${y.filename}": energy ${y.energy}%, brightness ${y.brightness}, bass ${y.bass_ratio}%
REFERENCE "${r.filename}": energy ${r.energy}%, brightness ${r.brightness}, bass ${r.bass_ratio}%
Give specific EQ, compression fixes. Top 3 changes. Real plugin names.`;

        const ai = await askAI(aiPrompt);

        const bl = [
          header('🆚 Mix Comparison Report'),
          twoCol(`🎵 *Your Track*\n${y.filename}`, `🎯 *Reference*\n${r.filename}`),
          divider(),
          section('*📊 Measured Differences*'),
        ];

        if (hasFull) {
          const gap = (mine, ref, unit, within) => {
            const diff = +(ref - mine).toFixed(1);
            const st = Math.abs(diff) <= within ? '✅ Match' : diff > 0 ? '🔴 Ref higher' : '🟢 Yours higher';
            return `${mine}${unit} → ${ref}${unit}  ${st}`;
          };
          bl.push(section([
            `🔊 *Loudness* — ${gap(y.lufs, r.lufs, ' LUFS', 1.5)}`,
            `🎚️ *Stereo Width* — ${gap(y.stereo_width, r.stereo_width, '%', 8)}`,
            `🟥 *Lows* — ${gap(y.low_pct, r.low_pct, '%', 5)}`,
            `🟩 *Mids* — ${gap(y.mid_pct, r.mid_pct, '%', 5)}`,
            `🟦 *Highs* — ${gap(y.high_pct, r.high_pct, '%', 5)}`,
            `⚡ *Energy* — ${gap(y.energy, r.energy, '%', 6)}`,
          ].join('\n')));
        } else {
          const ed = r.energy - y.energy, bd = r.bass_ratio - y.bass_ratio;
          bl.push(section([
            `⚡ *Energy*: ${y.energy}% → ${r.energy}%  ${Math.abs(ed)<=5?'✅ Match':ed>0?'🔴 Ref higher':'🟢 Yours higher'}`,
            `🔊 *Bass*: ${y.bass_ratio}% → ${r.bass_ratio}%  ${Math.abs(bd)<=5?'✅ Match':bd>0?'🔴 Ref heavier':'🟢 Yours heavier'}`,
            `🌈 *Brightness*: ${y.brightness} → ${r.brightness}`,
          ].join('\n')));
        }

        bl.push(divider(), header('🤖 How to Match the Reference'), section(ai || 'Could not generate.'), divider(), actions([btn('🆚 Compare Again', 'quick_compare', 'primary')]));
        await post(bl, 'Comparison ready');
      }
      return;
    }

    // ── NORMAL UPLOAD ────────────────────────────────────
    await post([header('🎵 Scanning Your Track...'), section(`*${file.name}*`), ctx('⏳ Deep analysis: loudness, stereo, spectral...')], 'Scanning');
    const a = await analyzeAudioFile(file.url_private_download, file.name);
    if (!a || a.error) { await post([header('❗ Scan Failed'), section('Try an MP3 or WAV under ~15MB.')], 'Error'); return; }

    if (userId) trackUpload(userId, file.name, a);
    global.pendingAnalysis = global.pendingAnalysis || {};
    global.pendingAnalysis[channelId] = { filename: file.name, ...a };

    const hasFull = a.lufs !== undefined;
    const bl = [header('🎛️ Scan Complete'), section(`*${file.name}*`), divider()];

    if (hasFull) {
      bl.push(twoCol(`🔊 *Loudness*\n${loudnessLabel(a.lufs)}`, `🎚️ *Stereo Width*\n${a.stereo_width}% ${a.stereo_width < 15 ? '— Narrow (mono-like)' : a.stereo_width > 60 ? '— Wide ✅' : '— Normal'}`));
      bl.push(twoCol(`📊 *Frequency Balance*\n🟥 Low: ${a.low_pct}%  🟩 Mid: ${a.mid_pct}%  🟦 High: ${a.high_pct}%`, `🎤 *Vocal Clarity*\n${vocalClarityLabel(a.vocal_clarity)}`));
      bl.push(twoCol(`⚡ *Energy*\n${a.energy}% ${a.energy < 40 ? '— Lacks punch' : a.energy > 80 ? '— Very punchy ✅' : '— Good'}`, `🌈 *Brightness*\n${a.brightness}`));
      bl.push(section(`📋 *Frequency Analysis:* ${freqLabel(a.low_pct, a.mid_pct, a.high_pct)}`));
    } else {
      const mins = Math.floor(a.duration/60), secs = String(a.duration%60).padStart(2,'0');
      const issues = [];
      if (a.energy < 50) issues.push('⚠️ Low energy — mix may lack punch');
      if (a.bass_ratio > 65) issues.push('⚠️ Heavy bass — may sound muddy on small speakers');
      if (a.bass_ratio < 20) issues.push('⚠️ Thin bass — needs more low end');
      bl.push(twoCol(`⚡ *Energy*\n${a.energy}%`, `🌈 *Brightness*\n${a.brightness}`));
      bl.push(twoCol(`🔊 *Bass*\n${a.bass_ratio}%`, `⏱️ *Duration*\n${mins}:${secs}`));
      if (issues.length) bl.push(divider(), section(`*Quick Insights:*\n${issues.join('\n')}`));
    }

    bl.push(
      divider(),
      section('*What would you like to do?*'),
      actions([btn('🎚️ Get Mix Feedback', 'quick_feedback', 'primary'), btn('🆚 Compare with Reference', 'quick_compare')]),
      actions([btn('🆕 New Releases', 'releases_global'), btn('🎓 DAW Guru', 'guru_open'), btn('📌 My Projects', 'project_list')]),
      ctx('🤖 I\'ll DM you a follow-up reminder tomorrow')
    );
    await post(bl, 'Scan complete');
    if (userId) { try { await publishAppHome(client, userId); } catch(e){} }

  } catch (e) { console.error('File handler:', e.message); }
});

// ─── SCHEDULER ────────────────────────────────────────────
function startScheduler(client) {

  // 24hr reminders — file-based so they survive restarts
  const checkReminders = async () => {
    try {
      const now = new Date();
      let changed = false;
      for (const userId of Object.keys(global.pendingReminders)) {
        for (const rem of global.pendingReminders[userId]) {
          if (rem.sent || new Date(rem.remindAt) > now) continue;
          rem.sent = true;
          changed = true;
          console.log(`📬 Reminder → ${userId} for "${rem.filename}"`);
          const a = rem.analysis;
          const issues = [];
          if (a.energy < 50) issues.push('☐ Low energy — needs more punch');
          if ((a.bass_ratio || a.low_pct || 0) > 65) issues.push('☐ Heavy bass — check on small speakers');
          if ((a.bass_ratio || a.low_pct || 0) < 20) issues.push('☐ Thin bass — add more low end');
          if (a.lufs !== undefined && a.lufs < -18) issues.push('☐ Quiet master — needs louder limiting');
          await client.chat.postMessage({
            channel: userId,
            text: 'Wavmind check-in',
            blocks: [
              header('🎛️ Wavmind Check-in'),
              section(`Hey! You uploaded *"${rem.filename}"* yesterday.\n\nHave you worked on it since?`),
              divider(),
              ...(issues.length > 0 ? [section(`*Issues detected:*\n${issues.join('\n')}`)] : [section('✅ Your track scanned clean. Ready to release?')]),
              divider(),
              actions([btn('🆚 Compare with Reference', 'quick_compare', 'primary'), btn('🎚️ Get Fresh Feedback', 'quick_feedback')]),
              ctx('🤖 Autonomous check-in from Wavmind'),
            ],
          });
          try { await publishAppHome(client, userId); } catch (e) {}
        }
      }
      if (changed) saveReminders(global.pendingReminders);
    } catch (e) { console.error('Reminders check:', e.message); }
  };

  checkReminders();
  setInterval(checkReminders, 5 * 60 * 1000);

  // Weekly digest every Monday 9am
  const sendDigest = async () => {
    try {
      for (const userId of Object.keys(global.weeklyStats)) {
        const stats = global.weeklyStats[userId];
        if (!stats || stats.tracks === 0) continue;
        const topIssue = stats.issues.sort((a,b) => stats.issues.filter(i=>i===b).length - stats.issues.filter(i=>i===a).length)[0] || 'None';
        const tip = await askAI(`Producer analyzed ${stats.tracks} tracks this week. Issue: ${topIssue}. One specific tip. Under 50 words.`);
        await client.chat.postMessage({
          channel: userId,
          text: 'Weekly report',
          blocks: [
            header('📊 Your Weekly Report'),
            section(`*Week of ${new Date().toLocaleDateString()}*`),
            divider(),
            twoCol(`🎵 *Tracks Scanned*\n${stats.tracks}`, `⚠️ *Top Issue*\n${topIssue}`),
            divider(),
            section(`*🤖 Wavmind tip:*\n${tip || 'Keep producing!'}`),
            divider(),
            section('*Try this week:*\n`/wavmind compare` — Check your mix\n`/wavmind samples` — Find new sounds\n`/wavmind daw [daw] [question]` — Learn something new'),
            ctx('📊 Automated weekly report · Every Monday · Wavmind'),
          ],
        });
        global.weeklyStats[userId] = { tracks: 0, issues: [] };
        saveStats(global.weeklyStats);
      }
    } catch (e) { console.error('Digest:', e.message); }
  };

  const now = new Date(), nextMon = new Date();
  nextMon.setDate(now.getDate() + ((1 + 7 - now.getDay()) % 7 || 7));
  nextMon.setHours(9, 0, 0, 0);
  setTimeout(() => { sendDigest(); setInterval(sendDigest, 7*24*3600*1000); }, nextMon - now);

  console.log('⏰ Scheduler: reminders every 5min · digest Monday 9am · DAW Guru daily 9am');

  // DAW Guru — daily tips at 9am
  const sendDawGuruTips = async () => {
    try {
      for (const userId of Object.keys(global.dawGuruProfiles)) {
        const p = global.dawGuruProfiles[userId];
        if (!p?.daw || !p?.level || p.paused) continue;
        console.log(`🎓 DAW Guru tip → ${userId} (${p.daw} / ${p.level})`);
        const tip = await getDawGuruTip(p.daw, p.level, p.focus);
        if (!tip) continue;
        const li = DAW_LEVELS[p.level] || DAW_LEVELS.intermediate;
        await client.chat.postMessage({
          channel: userId,
          text: 'DAW Guru daily tip',
          blocks: [
            header(`🎓 Daily ${p.daw} Tip`),
            section(`${li.emoji} *${li.label} level${p.focus ? ` · ${p.focus}` : ''}*`),
            divider(),
            section(tip),
            divider(),
            section('*Want to practice?*\n`/wavmind daw guru tip` — Another tip\n`/wavmind daw guru set focus [area]` — Change focus\n`/wavmind daw guru set level [level]` — Update level'),
            ctx('🎓 DAW Guru · Daily tips · Type `/wavmind daw guru stop` to pause'),
          ],
        });
      }
    } catch (e) { console.error('DAW Guru scheduler:', e.message); }
  };

  // Schedule DAW Guru tips daily at 9am
  const nowDG = new Date(), next9am = new Date();
  next9am.setDate(nowDG.getDate() + (nowDG.getHours() >= 9 ? 1 : 0));
  next9am.setHours(9, 0, 0, 0);
  setTimeout(() => { sendDawGuruTips(); setInterval(sendDawGuruTips, 24 * 60 * 60 * 1000); }, next9am - nowDG);
  console.log(`🎓 DAW Guru tips scheduled for ${next9am.toLocaleString()}`);

  // Project reminders — daily at 10am
  const sendProjectReminders = async () => {
    try {
      for (const userId of Object.keys(global.userProjects)) {
        const projects = global.userProjects[userId].filter(p => !p.done && p.reminders);
        if (!projects.length) continue;
        for (const proj of projects) {
          const days = Math.floor((Date.now() - new Date(proj.createdAt)) / (1000*60*60*24));
          const lastUpdated = proj.lastUpdated ? Math.floor((Date.now() - new Date(proj.lastUpdated)) / (1000*60*60*24)) : days;
          // Only remind if not updated in 2+ days
          if (lastUpdated < 2) continue;
          console.log(`📌 Project reminder → ${userId} "${proj.name}"`);
          const motivation = await askAI(`Music producer has been working on "${proj.name}" for ${days} days. Give one specific motivational tip or next step to help them progress. Under 30 words. Direct and actionable.`);
          await client.chat.postMessage({
            channel: userId,
            text: 'Project reminder',
            blocks: [
              header('📌 Project Check-in'),
              section(`*"${proj.name}"*
📅 Day ${days} · Last update: ${lastUpdated} days ago`),
              divider(),
              section(motivation || 'Keep going! Every session moves the project forward.'),
              divider(),
              section(`\`/wavmind project update ${proj.name} | [what you did]\` — Log progress\n\`/wavmind project done ${proj.name}\` — Mark complete`),
              ctx('📌 Project tracker · Type `/wavmind project list` to see all'),
            ],
          });
        }
      }
    } catch (e) { console.error('Project reminders:', e.message); }
  };

  // Schedule project reminders daily at 10am
  const next10am = new Date();
  next10am.setDate(next10am.getDate() + (new Date().getHours() >= 10 ? 1 : 0));
  next10am.setHours(10, 0, 0, 0);
  setTimeout(() => { sendProjectReminders(); setInterval(sendProjectReminders, 24*60*60*1000); }, next10am - new Date());
  console.log(`📌 Project reminders scheduled for ${next10am.toLocaleString()}`);
}

// ─── MCP SERVER ───────────────────────────────────────────
function startMCPServer() {
  const tools = [
    { name: 'search_samples',    description: 'Search 500K+ free Creative Commons samples from Freesound' },
    { name: 'get_track_features',description: 'Get real Spotify audio features for any track' },
    { name: 'analyze_mix',       description: 'Get AI mixing feedback from a description' },
    { name: 'get_daw_help',      description: 'DAW tutorials via Tavily + AI' },
    { name: 'compare_artists',   description: 'Compare two artists via Spotify data' },
    { name: 'get_track_ideas',   description: 'Generate track concepts for any genre' },
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
        if (req.url === '/health') { res.writeHead(200); res.end(JSON.stringify({ status: 'ok', service: 'Wavmind AI Producer Agent', version: '2.0.0', tools: tools.map(t=>t.name) })); return; }
        if (req.url === '/mcp') { res.writeHead(200); res.end(JSON.stringify({ name: 'wavmind', version: '2.0.0', description: 'AI tools for music producers', tools })); return; }
        if (req.url === '/mcp/tools') { res.writeHead(200); res.end(JSON.stringify({ tools })); return; }
        if (req.method === 'POST' && req.url === '/mcp/execute') {
          const { tool, arguments: args } = JSON.parse(body);
          let result;
          switch (tool) {
            case 'search_samples':     result = await searchFreesound(args.query); break;
            case 'get_track_features': result = await getTrackFeatures(args.track_name); break;
            case 'analyze_mix':        result = await askAI(`Mix feedback: ${args.description}`); break;
            case 'get_daw_help': {
              const [t,a] = await Promise.all([tavilySearch(`${args.daw} ${args.question}`), askAI(`${args.daw} tutorial: "${args.question}"`)]);
              result = { ai_answer: a, web_answer: t?.answer }; break;
            }
            case 'compare_artists': {
              const [s1,s2] = await Promise.all([getArtistStats(args.artist1), getArtistStats(args.artist2)]);
              result = { artist1: s1, artist2: s2 }; break;
            }
            case 'get_track_ideas': result = await askAI(`5 track ideas for "${args.genre}"`); break;
            default: result = { error: `Unknown tool: ${tool}` };
          }
          res.writeHead(200); res.end(JSON.stringify({ tool, result })); return;
        }
        res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    });
  });
  const port = process.env.PORT || 8000;
  server.listen(port, () => console.log(`🔌 MCP Server on port ${port}`));
}

// ─── SLASH COMMANDS ───────────────────────────────────────
app.command('/wavmind', async ({ command, ack, respond, client }) => {
  await ack();
  const input = command.text.trim();
  const lower = input.toLowerCase();
  const userId = command.user_id;
  const channelId = command.channel_id;
  // Use respond() for first reply (ephemeral), then postMessage for follow-ups
  let firstSent = false;
  const send = async (blocks, t) => {
    if (!firstSent) {
      firstSent = true;
      return respond({ text: t || 'Wavmind', blocks, response_type: 'ephemeral' });
    }
    return client.chat.postMessage({ channel: channelId, text: t || 'Wavmind', blocks });
  };

  if (!input || lower === 'help' || lower === 'menu') { await send(getWelcomeBlocks(), 'Welcome'); return; }

  // ── COMPARE ──────────────────────────────────────────
  if (lower === 'compare' || lower === 'compare start') {
    if (getCompareSession(userId)) { await send([header('⚠️ Already Running'), section('Cancel: `/wavmind cancel`')], 'Active'); return; }
    startCompareSession(userId);
    await send([
      header('🆚 Mix Comparison Started'),
      section(`*<@${userId}>* follow these steps:`),
      divider(),
      section('*Step 1* — Upload YOUR track\n_The beat you\'re working on_'),
      section('*Step 2* — Upload your REFERENCE track\n_The song you want to sound like_'),
      section('*Step 3* — Wavmind automatically:\n• Compares energy, bass, brightness\n• LUFS loudness, stereo width, spectral balance\n• Shows ✅ Match or 🔴 Gap for each element\n• Gives specific AI advice to close each gap'),
      divider(),
      ctx('Upload your track now · Cancel: `/wavmind cancel`'),
    ], 'Compare started');
    return;
  }

  if (lower === 'cancel') { clearCompareSession(userId); await send([header('🗑️ Cancelled'), section('Start again: `/wavmind compare`')], 'Cancelled'); return; }

  // ── SAMPLES ──────────────────────────────────────────
  if (lower.startsWith('sample')) {
    const q = input.replace(/^samples?\s*/i, '').trim();
    if (!q) {
      await send([header('🎵 Free Samples'), section('Search 500,000+ Creative Commons sounds.\n\n`/wavmind samples drums` · `/wavmind samples piano`\n`/wavmind samples bass` · `/wavmind samples synth`\n`/wavmind samples guitar` · `/wavmind samples strings`\n`/wavmind samples vocal` · `/wavmind samples ambient`\n\n_Run the same command again for different results!_'), ctx('All Creative Commons — free to use')], 'Samples');
      return;
    }
    await send([section(`🔍 Finding *"${q}"* samples...`), ctx('⏳ Different results every search')], 'Searching');
    const sounds = await searchFreesound(q, userId);
    if (!sounds?.length) {
      await send([header('❗ No Results'), section(`No sounds for *"${q}"*\n\nTry: piano · drums · bass · guitar · synth`), section(`🔗 *<https://freesound.org/search/?q=${encodeURIComponent(q)}|Browse Freesound>*`)], 'No results');
      return;
    }
    const tip = await askAI(`Producer needs "${q}" samples. 2 quick tips under 40 words. Bullets.`);
    const bl = [header(`🎵 Free Samples: "${q}"`), section(`*${sounds.length} sounds* — all free · _Different results every search_`), ctx('🔊 Click Listen · 📥 Click Download'), divider()];
    sounds.forEach((s, i) => {
      bl.push(section(`*${i+1}. ${s.name}*\n⏱️ *${s.duration}s* · ⭐ *${s.rating}/5* · 📥 *${s.downloads.toLocaleString()}*\n📄 ${s.license} · 👤 ${s.username}\n🏷️ ${s.tags}\n\n${s.preview?`🔊 *<${s.preview}|▶ Listen>*     `:''}🔗 *<${s.url}|📥 Download>*`));
      if (i < sounds.length - 1) bl.push(divider());
    });
    if (tip) bl.push(divider(), header(`💡 Tips for "${q}"`), section(tip));
    bl.push(divider(), section(`🔗 *<https://freesound.org/search/?q=${encodeURIComponent(q)}|Browse more on Freesound>*`), ctx(`Run \`/wavmind samples ${q}\` again for different sounds`));
    await send(bl, 'Samples');
    return;
  }

  // ── REFERENCE ─────────────────────────────────────────
  if (lower.startsWith('reference')) {
    const q = input.slice(9).trim();
    if (!q) { await send([header('🔍 Reference'), section('`/wavmind reference Blinding Lights - The Weeknd`')], 'Reference'); return; }
    await send([header('🔍 Looking up on Spotify...'), section(`*${q}*`), ctx('⏳')], 'Searching');
    const f = await getTrackFeatures(q);
    if (f) {
      const r = await askAI(`How to achieve sound of ${f.name} by ${f.artist}: BPM ${f.bpm}, Key ${f.key}, Energy ${f.energy}%, Loudness ${f.loudness}dB. Specific techniques + real plugins.`);
      await send([header('🎵 Reference Analysis'), section(`*${f.name}* by *${f.artist}*`), divider(), section('📊 *Real Spotify Data*'), twoCol(`🥁 *BPM*\n${f.bpm}`, `🎵 *Key*\n${f.key}`), twoCol(`⚡ *Energy*\n${f.energy}%`, `💃 *Danceability*\n${f.danceability}%`), twoCol(`🔊 *Loudness*\n${f.loudness} dB`, `😊 *Valence*\n${f.valence}%`), divider(), section('🎛️ *How to achieve this sound:*'), section(r || 'Error'), divider(), ctx('Type `/wavmind compare` to compare your track against this')], 'Reference');
    } else {
      const r = await askAI(`Production blueprint for "${q}". Tempo, key, drums, bass, melody, mix approach.`);
      await send([header('🎵 Reference Analysis'), section(`*${q}*`), divider(), section(r || 'Error')], 'Reference');
    }
    return;
  }

  // ── FEEDBACK ──────────────────────────────────────────
  if (lower.startsWith('feedback')) {
    const stored = global.pendingAnalysis?.[command.channel_id];
    const rest = input.slice(8).trim();

    // If audio was scanned in this channel, use that data automatically
    if (stored) {
      const desc = rest || 'my track';
      await send([header('🎚️ Generating Mix Feedback...'), section(`_Analyzing your uploaded track with measured data..._`), ctx('⏳')], 'Analyzing');
      const hasFull = stored.lufs !== undefined;
      const dataStr = hasFull
        ? `Energy: ${stored.energy}%, Loudness: ${stored.lufs} LUFS, Stereo Width: ${stored.stereo_width}%, Low: ${stored.low_pct}%, Mid: ${stored.mid_pct}%, High: ${stored.high_pct}%, Brightness: ${stored.brightness}, Vocal Clarity: ${stored.vocal_clarity}%`
        : `Energy: ${stored.energy}%, Brightness: ${stored.brightness}, Bass: ${stored.bass_ratio}%, Duration: ${stored.duration}s`;
      const prompt = `Professional mastering engineer. Here is MEASURED audio analysis data for "${stored.filename}":
${dataStr}
${desc !== 'my track' ? `Producer notes: "${desc}"` : ''}
Give specific mix feedback based on these exact measurements:
1. Loudness & dynamics — is it loud enough? Needs compression?
2. Frequency balance — based on the low/mid/high data
3. Stereo field — is the width good or needs widening/narrowing?
4. Top 3 specific things to fix with real plugin names and exact settings
Be direct and specific. Use the actual numbers.`;
      const r = await askAI(prompt);
      if (global.pendingAnalysis?.[command.channel_id]) delete global.pendingAnalysis[command.channel_id];
      const bl = [
        header('🎛️ Mix Feedback'),
        section(`*${stored.filename}*`),
        divider(),
      ];
      if (hasFull) {
        bl.push(twoCol(`🔊 *Loudness*\n${loudnessLabel(stored.lufs)}`, `🎚️ *Stereo Width*\n${stored.stereo_width}%`));
        bl.push(twoCol(`📊 *Low / Mid / High*\n${stored.low_pct}% / ${stored.mid_pct}% / ${stored.high_pct}%`, `⚡ *Energy*\n${stored.energy}%`));
      } else {
        bl.push(twoCol(`⚡ *Energy*\n${stored.energy}%`, `🔊 *Bass*\n${stored.bass_ratio}%`));
      }
      bl.push(divider(), section(r || 'Error'), ctx('Type `/wavmind compare` to compare with a reference track'));
      await send(bl, 'Feedback');
      return;
    }

    // No scan data — use text description
    if (!rest) {
      await send([
        header('🎚️ Mix Feedback'),
        section('*Two ways to get feedback:*\n\n*1. Upload audio first (recommended)*\n   Upload any MP3 or WAV → Wavmind scans it → then type `/wavmind feedback`\n\n*2. Describe your mix*\n   `/wavmind feedback my trap beat feels muddy and lacks punch`'),
        ctx('Audio upload gives much more specific feedback based on real measurements'),
      ], 'Feedback');
      return;
    }
    await send([header('🎚️ Analyzing...'), section(`_"${rest}"_`), ctx('⏳')], 'Analyzing');
    const r = await askAI(`Professional mixing engineer. Give specific feedback for: "${rest}". Cover: EQ, compression, stereo, loudness, arrangement. Use real plugin names and specific Hz/dB values. Format with emojis.`);
    await send([header('🎚️ Mix Feedback'), section(`_${rest}_`), divider(), section(r || 'Error'), ctx('💡 Upload your MP3/WAV first for deeper analysis based on real measurements')], 'Feedback');
    return;
  }

  // ── LABEL (A&R) ───────────────────────────────────────
  if (lower.startsWith('label')) {
    const desc = input.slice(5).trim();
    if (!desc) { await send([header('🎯 Label Evaluation'), section('`/wavmind label dark trap 140bpm heavy 808s melodic piano`')], 'Label'); return; }
    await send([header('🎯 A&R Evaluation...'), section(`_"${desc}"_`), ctx('⏳ Label exec reviewing your track')], 'Analyzing');
    const r = await askAI(`Senior A&R executive evaluation: "${desc}". Commercial Potential (1-10), Playlist Potential, Target Audience, Strengths, Weaknesses, Verdict (pass/consider/strong interest). Be honest and specific.`);
    await send([header('🎯 Label Evaluation'), section(`_${desc}_`), divider(), section(r || 'Error')], 'Label');
    return;
  }

  // ── ARTIST COMPARISON ─────────────────────────────────
  if (lower.startsWith('artist')) {
    const artists = input.slice(6).trim();
    if (!artists) { await send([header('🎤 Artist Comparison'), section('`/wavmind artist Drake and Travis Scott`\n`/wavmind artist Kanye vs Tyler the Creator`')], 'Artists'); return; }
    await send([header('🔍 Comparing Artists...'), ctx('⏳ Fetching Spotify data')], 'Comparing');
    let a1, a2;
    if (/\sand\s/i.test(artists)) [a1,a2] = artists.split(/\s+and\s+/i).map(s=>s.trim());
    else if (/\svs\s/i.test(artists)) [a1,a2] = artists.split(/\s+vs\s+/i).map(s=>s.trim());
    else { const w=artists.split(' '); const m=Math.ceil(w.length/2); a1=w.slice(0,m).join(' '); a2=w.slice(m).join(' '); }
    const [s1,s2] = await Promise.all([getArtistStats(a1), getArtistStats(a2)]);
    if (!s1||!s2) { await send([header('❗ Not Found'), section('`/wavmind artist Drake and Travis Scott`')], 'Error'); return; }
    const ai = await askAI(`Compare: ${s1.name} (BPM ${s1.bpm}, Energy ${s1.energy}%, Key ${s1.key}) vs ${s2.name} (BPM ${s2.bpm}, Energy ${s2.energy}%, Key ${s2.key}). Key production differences, how to blend.`);
    await send([
      header('🎤 Artist Comparison'),
      section(`*${s1.name}* vs *${s2.name}*`),
      divider(),
      section('📊 *Real Spotify Data*'),
      { type:'section', fields:[{ type:'mrkdwn', text:`*${s1.name}*` },{ type:'mrkdwn', text:`*${s2.name}*` }] },
      { type:'section', fields:[{ type:'mrkdwn', text:`🥁 BPM: *${s1.bpm}*` },{ type:'mrkdwn', text:`🥁 BPM: *${s2.bpm}*` }] },
      { type:'section', fields:[{ type:'mrkdwn', text:`⚡ Energy: *${s1.energy}%*` },{ type:'mrkdwn', text:`⚡ Energy: *${s2.energy}%*` }] },
      { type:'section', fields:[{ type:'mrkdwn', text:`🔊 Loud: *${s1.loudness}dB*` },{ type:'mrkdwn', text:`🔊 Loud: *${s2.loudness}dB*` }] },
      { type:'section', fields:[{ type:'mrkdwn', text:`🎵 Key: *${s1.key}*` },{ type:'mrkdwn', text:`🎵 Key: *${s2.key}*` }] },
      divider(),
      section(ai || 'Error'),
    ], 'Artists');
    return;
  }

  // ── DAW ───────────────────────────────────────────────
  if (lower.startsWith('daw') && !lower.startsWith('daw guru') && !lower.startsWith('dawguru')) {
    const dawInput = input.slice(3).trim();
    if (!dawInput) { await send([header('🎸 DAW Help'), section('`/wavmind daw fl studio sidechain 808`\n`/wavmind daw ableton warp audio`\n`/wavmind daw logic pro flex pitch`\n`/wavmind daw pro tools set up sessions`'), ctx('FL Studio · Ableton · Logic Pro · Pro Tools · Cubase · Studio One · GarageBand · Reaper · Bitwig')], 'DAW'); return; }
    const dawList = [
      { name: 'FL Studio', kw: ['fl studio','fl','fruity loops'] },
      { name: 'Ableton Live', kw: ['ableton','ableton live','live'] },
      { name: 'Logic Pro', kw: ['logic','logic pro','logic pro x'] },
      { name: 'Pro Tools', kw: ['pro tools','protools'] },
      { name: 'Cubase', kw: ['cubase'] },
      { name: 'Studio One', kw: ['studio one','studio 1'] },
      { name: 'GarageBand', kw: ['garageband','garage band'] },
      { name: 'Reason', kw: ['reason'] },
      { name: 'Bitwig', kw: ['bitwig'] },
      { name: 'Reaper', kw: ['reaper'] },
    ];
    let detectedDAW = null, question = dawInput;
    for (const d of dawList) {
      for (const k of d.kw) {
        if (dawInput.toLowerCase().startsWith(k)) { detectedDAW = d.name; question = dawInput.slice(k.length).trim(); break; }
      }
      if (detectedDAW) break;
    }
    if (!detectedDAW) { await send([header('❗ DAW Not Recognized'), section('Example: `/wavmind daw fl studio sidechain 808`'), ctx('FL Studio · Ableton · Logic Pro · Pro Tools · Cubase · Studio One')], 'Error'); return; }
    await send([header(`🎸 ${detectedDAW} Help`), section(`*Q:* ${question}`), ctx('⏳ Searching + generating answer...')], 'Searching');
    const [tav, ai] = await Promise.all([
      tavilySearch(`${detectedDAW} ${question} tutorial step by step`),
      askAI(`Expert ${detectedDAW} instructor. Answer: "${question}". Numbered steps. Bold key terms.`),
    ]);
    const bl = [header(`🎸 ${detectedDAW}: ${question}`), divider(), section('🤖 *AI Answer:*'), section(ai || 'Error')];
    if (tav?.answer) bl.push(divider(), section('🌐 *From the Web:*'), section(tav.answer));
    if (tav?.results?.length) bl.push(divider(), section('📚 *Resources:*'), section(tav.results.slice(0,4).map(r=>`• <${r.url}|${r.title}>`).join('\n')));
    bl.push(ctx(`🎸 ${detectedDAW} · Tavily + Groq AI`));
    await send(bl, 'DAW help');
    return;
  }

  // ── COLLAB ────────────────────────────────────────────
  if (lower.startsWith('collab')) {
    const name = input.slice(6).trim().replace(/['"]/g,'') || 'Untitled';
    if (getCollabSession(command.channel_id)) { await send([header('⚠️ Session Active'), section('Type `/wavmind end` to finish first')], 'Active'); return; }
    startCollabSession(command.channel_id, name, userId);
    await respond({ response_type: 'in_channel', text: 'Collab started', blocks: [header('🤝 Collab Session Started'), section(`*Track:* "${name}"\n*By:* <@${userId}>`), divider(), section('Log your work:\n`/wavmind idea [idea]` — Log an idea\n`/wavmind note [feedback]` — Log feedback\n`/wavmind decided [decision]` — Log a decision\n`/wavmind summary` — AI summary\n`/wavmind end` — End session'), ctx(`Session active for "${name}"`) ] });
    return;
  }
  if (lower.startsWith('idea ')) {
    const t=input.slice(5).trim(); const s=getCollabSession(command.channel_id);
    if (!s) { await send([header('❗ No Session'), section('`/wavmind collab [track name]`')], 'No session'); return; }
    s.ideas.push({ text: t, user: userId, time: new Date().toISOString() });
    await respond({ response_type:'in_channel', text:'Idea logged', blocks:[header('💡 Idea Logged'),section(`*"${t}"*\n— <@${userId}>`),ctx(`${s.ideas.length} ideas for "${s.trackName}"`)] });
    return;
  }
  if (lower.startsWith('note ')) {
    const t=input.slice(5).trim(); const s=getCollabSession(command.channel_id);
    if (!s) { await send([header('❗ No Session'), section('`/wavmind collab [track name]`')], 'No session'); return; }
    s.feedback.push({ text: t, user: userId, time: new Date().toISOString() });
    await respond({ response_type:'in_channel', text:'Note logged', blocks:[header('📝 Note Logged'),section(`*"${t}"*\n— <@${userId}>`),ctx(`${s.feedback.length} notes for "${s.trackName}"`)] });
    return;
  }
  if (lower.startsWith('decided ')) {
    const t=input.slice(8).trim(); const s=getCollabSession(command.channel_id);
    if (!s) { await send([header('❗ No Session'), section('`/wavmind collab [track name]`')], 'No session'); return; }
    s.decisions.push({ text: t, user: userId, time: new Date().toISOString() });
    await respond({ response_type:'in_channel', text:'Decision logged', blocks:[header('✅ Decision Logged'),section(`*"${t}"*\n— <@${userId}>`),ctx(`${s.decisions.length} decisions for "${s.trackName}"`)] });
    return;
  }
  if (lower === 'summary') {
    const s=getCollabSession(command.channel_id);
    if (!s) { await send([header('❗ No Session'), section('`/wavmind collab [track name]`')], 'No session'); return; }
    const r = await askAI(`Summarize collab for "${s.trackName}": IDEAS: ${s.ideas.map(i=>i.text).join(', ')||'None'} NOTES: ${s.feedback.map(f=>f.text).join(', ')||'None'} DECISIONS: ${s.decisions.map(d=>d.text).join(', ')||'None'}. Overview, direction, next steps.`);
    await respond({ response_type:'in_channel', text:'Summary', blocks:[header('📋 Session Summary'),section(`*"${s.trackName}"*`),divider(),twoCol(`💡 ${s.ideas.length} ideas`,`📝 ${s.feedback.length} notes`),twoCol(`✅ ${s.decisions.length} decisions`,`⏱️ ${new Date(s.startedAt).toLocaleTimeString()}`),divider(),section(r||'Error'),ctx('`/wavmind end` to finish')] });
    return;
  }
  if (lower === 'end') {
    const s=getCollabSession(command.channel_id);
    if (!s) { await send([header('❗ No Active Session')], 'No session'); return; }
    const r = await askAI(`Final report for "${s.trackName}": IDEAS: ${s.ideas.map(i=>i.text).join(', ')||'None'} NOTES: ${s.feedback.map(f=>f.text).join(', ')||'None'} DECISIONS: ${s.decisions.map(d=>d.text).join(', ')||'None'}. Overview, decisions, action items.`);
    endCollabSession(command.channel_id);
    await respond({ response_type:'in_channel', text:'Session complete', blocks:[header('🏁 Session Complete'),section(`*"${s.trackName}"*`),divider(),section(r||'Error'),ctx('`/wavmind collab [name]` for new session')] });
    return;
  }

  // ── PRODUCTION TOOLS ─────────────────────────────────
  if (lower.startsWith('ideas')) { const g=input.slice(5).trim()||'general'; const r=await askAI(`5 creative track ideas for "${g}". Format: 🎵 *Title* — concept.`); await send([header('🎵 Track Ideas'),section(`*Genre:* ${g}`),divider(),section(r||'Error')], 'Ideas'); return; }
  if (lower.startsWith('bpm'))   { const g=input.slice(3).trim()||'general'; const r=await askAI(`For "${g}": ideal BPM range, best keys, chord progressions, structure. Specific numbers.`); await send([header('🥁 BPM & Key'),section(`*Genre:* ${g}`),divider(),section(r||'Error')], 'BPM'); return; }
  if (lower.startsWith('chords')){ const q=input.slice(6).trim()||'C minor'; const r=await askAI(`3 chord progressions for "${q}". Chords, Roman numerals, feel, melody note.`); await send([header('🎹 Chords'),section(`*${q}*`),divider(),section(r||'Error')], 'Chords'); return; }
  if (lower.startsWith('tips'))  { const q=input.slice(4).trim()||'music production'; const r=await askAI(`5 professional tips about "${q}". Real techniques and plugin names.`); await send([header('💡 Tips'),section(`*${q}*`),divider(),section(r||'Error')], 'Tips'); return; }
  if (lower.startsWith('release')){ const d=input.slice(7).trim(); if(!d){await send([header('❗ Missing'),section('`/wavmind release Trap beat 140bpm mixed`')],'Missing');return;} const r=await askAI(`Release readiness: "${d}". Mix Quality, Loudness LUFS, Metadata, Distribution, Score X/10. Checklist ✅ or ⚠️.`); await send([header('✅ Release Readiness'),section(`_${d}_`),divider(),section(r||'Error')], 'Release'); return; }

  // ── MCP ───────────────────────────────────────────────
  if (lower === 'mcp') {
    const base = `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'your-url.railway.app'}`;
    await send([header('🔌 MCP Server'), section(`${base}/health\n${base}/mcp/tools\n${base}/mcp/execute (POST)`), ctx('Compatible with Claude, GPT & any MCP client')], 'MCP');
    return;
  }

  // ── TEST REMINDER ─────────────────────────────────────
  if (lower === 'test reminder') {
    const ul = global.userUploads[userId] || [];
    const last = ul[ul.length - 1];
    if (!last) { await send([header('❗ Upload a track first')], 'No track'); return; }
    if (!global.pendingReminders[userId]) global.pendingReminders[userId] = [];
    global.pendingReminders[userId].push({ filename: last.filename, analysis: last.analysis, uploadedAt: new Date().toISOString(), remindAt: new Date(Date.now() + 10000).toISOString(), sent: false });
    saveReminders(global.pendingReminders);
    await send([header('⏰ Test Reminder Set'), section(`DM arriving in 10 seconds for *"${last.filename}"*`)], 'Set');
    return;
  }

  // ── NEW RELEASES ──────────────────────────────────────
  if (lower.startsWith('new releases') || lower.startsWith('newreleases') || lower === 'new') {
    const genre = input.replace(/^new releases?\s*/i, '').trim();
    await send([header('🆕 Latest on Spotify...'), ctx('⏳ Fetching new releases')], 'Fetching');
    let releases;
    if (genre) {
      releases = await searchNewReleasesByGenre(genre);
      if (!releases?.length) releases = await getNewReleases();
    } else {
      releases = await getNewReleases();
    }
    if (!releases?.length) { await send([header('❗ Could not fetch'), section('Try again shortly.')], 'Error'); return; }
    const bl = [header(`🆕 New Releases${genre ? ` — ${genre}` : ''}`), section(`*${releases.length} fresh tracks* on Spotify`), divider()];
    releases.forEach((rel, i) => {
      const date = rel.releaseDate ? `📅 ${rel.releaseDate}` : '';
      const pop = rel.popularity !== undefined ? `  🔥 ${rel.popularity}%` : '';
      bl.push(section(`*${i+1}. ${rel.name}*\n👤 ${rel.artist}${rel.album ? `\n💿 ${rel.album}` : ''}  ${date}${pop}\n🎵 *<${rel.url}|▶ Listen on Spotify>*`));
      if (i < releases.length - 1) bl.push(divider());
    });
    bl.push(divider(), actions([
      btn('🎵 Trap', 'releases_trap'), btn('🎵 Pop', 'releases_pop'),
      btn('🎵 R&B', 'releases_rnb'), btn('🎵 Hip-Hop', 'releases_hiphop'),
      btn('🔄 Refresh', 'releases_global'),
    ]), ctx('🎵 Spotify · Tap a genre for more'));
    await send(bl, 'New Releases');
    return;
  }

  // ── DAW GURU ──────────────────────────────────────────
  // Short alias: /wavmind guru = /wavmind daw guru
  const isGuruCmd = lower.startsWith('dawguru') || lower.startsWith('daw guru') || lower.startsWith('guru');
  if (isGuruCmd) {
    const sub = input.replace(/^(daw\s*guru|guru)\s*/i, '').trim().toLowerCase();
    const p = global.dawGuruProfiles[userId] || {};

    // SMART ONBOARDING: if not set up, guide step by step
    if (!sub || sub === 'setup' || sub === 'start' || sub === 'help') {
      if (!p.daw && !p.level) {
        await send([
          header('🎓 Welcome to DAW Guru!'),
          section('Your personal AI music tutor. Get *daily lessons* tailored to your DAW and skill level — sent to your DMs every morning automatically.\n\n*3 quick steps to set up:*'),
          divider(),
          section('*Step 1 — Which DAW do you use?*\n\n`/wavmind guru FL Studio`\n`/wavmind guru Ableton Live`\n`/wavmind guru Logic Pro`\n`/wavmind guru Pro Tools`\n`/wavmind guru Cubase`\n`/wavmind guru Studio One`'),
          ctx('🎓 Just type your DAW name after /wavmind guru'),
        ], 'DAW Guru');
      } else if (p.daw && !p.level) {
        await send([
          header(`🎓 DAW Guru — ${p.daw} ✅`),
          section('*Step 2 — What\'s your skill level?*'),
          divider(),
          section('`/wavmind guru beginner` — Just starting out\n`/wavmind guru intermediate` — Making beats, want to improve\n`/wavmind guru advanced` — Experienced producer\n`/wavmind guru professional` — Studio-level work'),
        ], 'DAW Guru');
      } else if (p.daw && p.level && !p.style) {
        const li3 = DAW_LEVELS[p.level] || DAW_LEVELS.intermediate;
        await send([
          header(`🎓 ${p.daw} · ${li3.emoji} ${li3.label} ✅`),
          section('*Step 3 — What\'s your main focus?*'),
          divider(),
          section('`/wavmind guru mixing`\n`/wavmind guru sound design`\n`/wavmind guru arrangement`\n`/wavmind guru mastering`\n`/wavmind guru beat making`\n`/wavmind guru general`'),
          section('Or skip to start now: `/wavmind guru skip`'),
        ], 'DAW Guru');
      } else {
        const li = DAW_LEVELS[p.level] || DAW_LEVELS.intermediate;
        await send([
          header('🎓 DAW Guru — Active'),
          twoCol(`🎛️ *DAW*\n${p.daw}`, `${li.emoji} *Level*\n${li.label}`),
          twoCol(`🎯 *Focus*\n${p.style || 'General'}`, `📅 *Lessons*\n${p.paused ? '⏸️ Paused' : 'Daily at 9am'}`),
          divider(),
          section('`/wavmind daw guru tip` — Get a lesson now\n`/wavmind daw guru status` — Full profile\n`/wavmind daw guru stop` — Pause\n`/wavmind daw guru restart` — Change settings'),
        ], 'DAW Guru');
      }
      return;
    }

    // SMART DETECTION: auto-detect what user typed
    const knownDAWs = ['fl studio','ableton live','ableton','logic pro','logic','pro tools','cubase','studio one','garageband','reaper','bitwig','reason','fruity loops'];
    const knownLevels = ['beginner','intermediate','advanced','professional'];
    const knownFocus = ['mixing','sound design','arrangement','mastering','beat making','general','melody','drums','bass','vocals','composition'];
    const matchedDAW = knownDAWs.find(d => sub === d || sub.startsWith(d + ' ') || sub === d.split(' ')[0]);
    const matchedLevel = knownLevels.find(l => sub === l);
    const matchedFocus = knownFocus.find(f => sub === f || sub.startsWith(f));

    // Auto-route based on profile completion + what was typed
    if (!sub.startsWith('set ') && !sub.startsWith('tip') && !sub.startsWith('status') && !sub.startsWith('stop') && !sub.startsWith('restart') && !sub.startsWith('skip') && !sub.startsWith('now') && !sub.startsWith('lesson') && !sub.startsWith('pause') && !sub.startsWith('reset') && !sub.startsWith('profile') && !sub.startsWith('focus') && !sub.startsWith('style')) {
      if (matchedDAW && !p.level) {
        // Treat as DAW name input → set daw
        const dawName = knownDAWs.find(d => sub === d || sub.startsWith(d)) || sub;
        const formatted = dawName.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        if (!global.dawGuruProfiles[userId]) global.dawGuruProfiles[userId] = {};
        global.dawGuruProfiles[userId].daw = formatted;
        global.dawGuruProfiles[userId].userId = userId;
        global.dawGuruProfiles[userId].paused = false;
        saveDawGuru(global.dawGuruProfiles);
        await send([
          header(`✅ DAW Set — ${formatted}`),
          section('*Step 2 — What\'s your skill level?*\n\n`/wavmind guru beginner`\n`/wavmind guru intermediate`\n`/wavmind guru advanced`\n`/wavmind guru professional`'),
        ], 'Saved');
        return;
      }
      if (matchedLevel) {
        // Treat as level input → set level
        if (!global.dawGuruProfiles[userId]) global.dawGuruProfiles[userId] = {};
        global.dawGuruProfiles[userId].level = sub;
        global.dawGuruProfiles[userId].userId = userId;
        global.dawGuruProfiles[userId].paused = false;
        saveDawGuru(global.dawGuruProfiles);
        const li = DAW_LEVELS[sub];
        const daw = global.dawGuruProfiles[userId].daw || 'your DAW';
        await send([
          header(`✅ Level Set — ${li.emoji} ${li.label}`),
          section('*Step 3 — What\'s your main focus?*\n\n`/wavmind guru mixing`\n`/wavmind guru sound design`\n`/wavmind guru arrangement`\n`/wavmind guru beat making`\n`/wavmind guru general`\n\nOr skip: `/wavmind guru skip`'),
        ], 'Saved');
        return;
      }
      if (matchedFocus && p.daw && p.level) {
        // Treat as focus input → set focus
        if (!global.dawGuruProfiles[userId]) global.dawGuruProfiles[userId] = {};
        global.dawGuruProfiles[userId].style = sub;
        saveDawGuru(global.dawGuruProfiles);
        const daw = global.dawGuruProfiles[userId].daw;
        const lvl = DAW_LEVELS[global.dawGuruProfiles[userId].level]?.label || 'Intermediate';
        await send([
          header('🎓 DAW Guru — You\'re All Set!'),
          section(`*${daw}* · *${lvl}* · *${sub}*\n\nDaily lessons start tomorrow at 9am. Get your first one now:`),
          section('`/wavmind guru tip`'),
          ctx('🤖 Autonomous · Daily DMs · Personalized to you'),
        ], 'Setup complete');
        return;
      }
    }

    // SET DAW (explicit)
    if (sub.startsWith('set daw ') || sub.startsWith('daw ')) {
      const daw = sub.replace(/^(set\s+daw|daw)\s+/i, '').trim() || input.replace(/^(daw\s*guru|guru)\s+(set\s+daw|daw)\s+/i, '').trim();
      if (!daw) { await send([header('❗ Which DAW?'), section('Example: `/wavmind daw guru set daw FL Studio`')], 'Missing'); return; }
      if (!global.dawGuruProfiles[userId]) global.dawGuruProfiles[userId] = {};
      global.dawGuruProfiles[userId].daw = daw;
      global.dawGuruProfiles[userId].userId = userId;
      global.dawGuruProfiles[userId].paused = false;
      saveDawGuru(global.dawGuruProfiles);
      // Auto-prompt next step
      if (!global.dawGuruProfiles[userId].level) {
        await send([
          header(`✅ DAW Set — ${daw}`),
          section('*Step 2 — What\'s your skill level?*\n\n`/wavmind guru beginner`\n`/wavmind guru intermediate`\n`/wavmind guru advanced`\n`/wavmind guru professional`'),
        ], 'Saved');
      } else {
        await send([header('✅ DAW Updated'), section(`*${daw}* saved. Type \`/wavmind daw guru tip\` to get a lesson now.`)], 'Saved');
      }
      return;
    }

    // SET LEVEL
    if (sub.startsWith('set level ')) {
      const lvl = sub.replace(/^set\s+level\s+/i, '').trim();
      if (!DAW_LEVELS[lvl]) { await send([header('❗ Invalid Level'), section('Use: `beginner` · `intermediate` · `advanced` · `professional`')], 'Invalid'); return; }
      if (!global.dawGuruProfiles[userId]) global.dawGuruProfiles[userId] = {};
      global.dawGuruProfiles[userId].level = lvl;
      global.dawGuruProfiles[userId].userId = userId;
      global.dawGuruProfiles[userId].paused = false;
      saveDawGuru(global.dawGuruProfiles);
      const li = DAW_LEVELS[lvl];
      const daw = global.dawGuruProfiles[userId].daw || 'your DAW';
      if (!global.dawGuruProfiles[userId].style) {
        await send([
          header(`✅ Level Set — ${li.emoji} ${li.label}`),
          section('*Step 3 — What\'s your main focus?*\n\n`/wavmind guru mixing`\n`/wavmind guru sound design`\n`/wavmind guru arrangement`\n`/wavmind guru beat making`\n`/wavmind guru general`\n\nOr skip: `/wavmind guru skip`'),
        ], 'Saved');
      } else {
        await send([header(`✅ Level Updated — ${li.emoji} ${li.label}`), section(`Daily ${daw} tips now calibrated for *${li.label}* level.`)], 'Saved');
      }
      return;
    }

    // SET FOCUS / STYLE
    if (sub.startsWith('set focus ') || sub.startsWith('set style ') || sub.startsWith('focus ') || sub.startsWith('style ')) {
      const style = sub.replace(/^(set\s+)?(focus|style)\s+/i, '').trim();
      if (!global.dawGuruProfiles[userId]) global.dawGuruProfiles[userId] = {};
      global.dawGuruProfiles[userId].style = style;
      saveDawGuru(global.dawGuruProfiles);
      const daw = global.dawGuruProfiles[userId].daw || 'your DAW';
      const lvl = DAW_LEVELS[global.dawGuruProfiles[userId].level]?.label || 'Intermediate';
      await send([
        header('🎓 DAW Guru — You\'re All Set!'),
        section(`*${daw}* · *${lvl}* · *${style}*\n\nYou\'ll receive daily lessons every morning at 9am, tailored exactly to your setup.\n\nGet your first lesson now:`),
        section('`/wavmind daw guru tip`'),
        ctx('🤖 Autonomous · Daily 9am DMs · Personalized to you'),
      ], 'Setup complete');
      return;
    }

    // SKIP focus step
    if (sub === 'skip') {
      if (!global.dawGuruProfiles[userId]) global.dawGuruProfiles[userId] = {};
      global.dawGuruProfiles[userId].style = 'general production';
      saveDawGuru(global.dawGuruProfiles);
      const daw = global.dawGuruProfiles[userId].daw || 'your DAW';
      await send([
        header('🎓 DAW Guru — Active!'),
        section(`Daily *${daw}* lessons start tomorrow at 9am.\n\nGet your first lesson now: \`/wavmind daw guru tip\``),
        ctx('🤖 Type `/wavmind daw guru stop` to pause anytime'),
      ], 'Active');
      return;
    }

    // RESTART — clear and restart onboarding
    if (sub === 'restart' || sub === 'reset') {
      delete global.dawGuruProfiles[userId];
      saveDawGuru(global.dawGuruProfiles);
      await send([header('🔄 DAW Guru Reset'), section('Starting fresh!\n\n`/wavmind daw guru` — Set up again')], 'Reset');
      return;
    }

    // STATUS
    if (sub === 'status' || sub === 'profile') {
      if (!p.daw || !p.level) { await send([header('🎓 Not Set Up Yet'), section('`/wavmind daw guru` — Get started')], 'Not set up'); return; }
      const li = DAW_LEVELS[p.level] || DAW_LEVELS.intermediate;
      const nextTip = p.lastTip ? `Last lesson: ${new Date(p.lastTip).toLocaleDateString()}` : 'No lessons yet';
      await send([
        header('🎓 Your DAW Guru Profile'),
        twoCol(`🎛️ *DAW*\n${p.daw}`, `${li.emoji} *Level*\n${li.label}`),
        twoCol(`🎯 *Focus*\n${p.style || 'General'}`, `📅 *Status*\n${p.paused ? '⏸️ Paused' : '✅ Active'}`),
        twoCol(`📖 *Lessons received*\n${p.tipsCount || 0}`, `🕐 *${nextTip}*\n`),
        divider(),
        section('`/wavmind guru tip` — Lesson now\n`/wavmind guru stop` — Pause\n`/wavmind guru restart` — Reset'),
      ], 'Profile');
      return;
    }

    // STOP
    if (sub === 'stop' || sub === 'pause') {
      if (global.dawGuruProfiles[userId]) { global.dawGuruProfiles[userId].paused = true; saveDawGuru(global.dawGuruProfiles); }
      await send([header('⏸️ DAW Guru Paused'), section('Daily lessons stopped.\n\n`/wavmind guru tip` — Get a lesson anytime\n`/wavmind guru` — Resume')], 'Paused');
      return;
    }

    // TIP / LESSON NOW
    if (sub === 'tip' || sub === 'now' || sub === 'lesson') {
      if (!p.daw || !p.level) {
        await send([header('🎓 Set Up DAW Guru First'), section('Type `/wavmind guru` to get started — takes 30 seconds.')], 'Setup needed');
        return;
      }
      await send([header(`🎓 Getting Your ${p.daw} Lesson...`), ctx('⏳ Generating personalized lesson')], 'Loading');
      const tip = await getDawGuruTip(p.daw, p.level, p.style);
      const li = DAW_LEVELS[p.level] || DAW_LEVELS.intermediate;
      // Track lesson count
      if (!global.dawGuruProfiles[userId]) global.dawGuruProfiles[userId] = p;
      global.dawGuruProfiles[userId].tipsCount = (p.tipsCount || 0) + 1;
      global.dawGuruProfiles[userId].lastTip = new Date().toISOString();
      saveDawGuru(global.dawGuruProfiles);
      await send([
        header(`🎓 ${p.daw} Lesson — ${li.emoji} ${li.label}`),
        ...(p.style && p.style !== 'general production' ? [section(`🎯 *Focus: ${p.style}*`)] : []),
        divider(),
        section(tip || 'Could not generate lesson. Try again.'),
        divider(),
        section(`📖 *Lesson ${global.dawGuruProfiles[userId].tipsCount}*`),
        ctx(`🎓 DAW Guru · ${p.daw} · Daily at 9am · Lesson ${global.dawGuruProfiles[userId].tipsCount}`),
      ], 'Lesson');
      return;
    }

    // Default — show status or prompt setup
    await send([header('🎓 DAW Guru'), section('`/wavmind guru` — Setup or status\n`/wavmind guru tip` — Lesson now\n`/wavmind guru stop` — Pause')], 'DAW Guru');
    return;
  }

  // ── PROJECT TRACKER ───────────────────────────────────
  if (lower.startsWith('project')) {
    const sub = input.slice(7).trim();
    const subL = sub.toLowerCase();

    if (!subL || subL === 'list' || subL === 'all') {
      const projects = global.userProjects[userId] || [];
      if (!projects.length) {
        await send([
          header('🎵 Project Tracker'),
          section('Track your music projects and get daily reminders.\n\n*Start a project:*\n`/wavmind project add My Dark Trap EP`\n\n*Other commands:*\n`/wavmind project list` — All projects\n`/wavmind project done [name]` — Mark complete\n`/wavmind project update [name] | [note]` — Add note\n`/wavmind project delete [name]` — Delete'),
        ], 'Projects');
        return;
      }
      const bl = [header(`🎵 Your Projects (${projects.length})`), divider()];
      projects.forEach((proj, i) => {
        const age = Math.floor((Date.now() - new Date(proj.createdAt)) / (1000*60*60*24));
        const lastNote = proj.notes?.slice(-1)[0];
        bl.push(section(
          `${proj.done ? '✅' : '🎵'} *${proj.name}*\n` +
          `📅 ${age} days ago · ${proj.done ? 'Completed' : 'In Progress'}\n` +
          (lastNote ? `📝 _${lastNote.text}_\n` : '') +
          `🔔 Reminders: ${proj.reminders ? 'On' : 'Off'}`
        ));
        if (i < projects.length - 1) bl.push(divider());
      });
      bl.push(divider(), ctx('`/wavmind project add [name]` · `/wavmind project done [name]`'));
      await send(bl, 'Projects');
      return;
    }

    if (subL.startsWith('add ')) {
      const name = sub.slice(4).trim();
      if (!name) { await send([header('❗ Missing name'), section('`/wavmind project add My Dark Trap EP`')], 'Missing'); return; }
      if (!global.userProjects[userId]) global.userProjects[userId] = [];
      const project = { id: Date.now(), name, createdAt: new Date().toISOString(), done: false, notes: [], reminders: true };
      global.userProjects[userId].push(project);
      saveProjects(global.userProjects);
      await send([
        header('🎵 Project Added'),
        section(`*"${name}"* is now being tracked.\n\nWavmind will send you daily reminders to keep working on it.`),
        twoCol('📝 Add a note', '✅ Mark done'),
        section('`/wavmind project update ' + name + ' | Started the drums`\n`/wavmind project done ' + name + '`'),
        ctx('🔔 Daily reminders enabled · Type `/wavmind project list` to see all'),
      ], 'Added');
      return;
    }

    if (subL.startsWith('done ')) {
      const name = sub.slice(5).trim();
      const projects = global.userProjects[userId] || [];
      const proj = projects.find(p => p.name.toLowerCase().includes(name.toLowerCase()));
      if (!proj) { await send([header('❗ Not Found'), section(`No project matching "${name}"\n\n\`/wavmind project list\` to see all`)], 'Not found'); return; }
      proj.done = true;
      proj.completedAt = new Date().toISOString();
      saveProjects(global.userProjects);
      const days = Math.floor((Date.now() - new Date(proj.createdAt)) / (1000*60*60*24));
      await send([
        header('🏆 Project Complete!'),
        section(`*"${proj.name}"* finished in *${days} days*! 🎉\n\nGreat work. Ready to start your next track?`),
        section('`/wavmind project add [new project name]`'),
      ], 'Done');
      return;
    }

    if (subL.startsWith('update ')) {
      const parts = sub.slice(7).split('|');
      const name = parts[0]?.trim();
      const note = parts[1]?.trim();
      if (!name || !note) { await send([header('❗ Format'), section('`/wavmind project update My EP | Finished the bridge section`')], 'Format'); return; }
      const projects = global.userProjects[userId] || [];
      const proj = projects.find(p => p.name.toLowerCase().includes(name.toLowerCase()));
      if (!proj) { await send([header('❗ Not Found'), section(`No project matching "${name}"`)], 'Not found'); return; }
      if (!proj.notes) proj.notes = [];
      proj.notes.push({ text: note, time: new Date().toISOString() });
      proj.lastUpdated = new Date().toISOString();
      saveProjects(global.userProjects);
      await send([header('📝 Note Added'), section(`*"${proj.name}"*\n📝 ${note}`), ctx(`${proj.notes.length} notes total`)], 'Updated');
      return;
    }

    if (subL.startsWith('delete ') || subL.startsWith('remove ')) {
      const name = sub.slice(subL.startsWith('delete') ? 7 : 7).trim();
      const projects = global.userProjects[userId] || [];
      const idx = projects.findIndex(p => p.name.toLowerCase().includes(name.toLowerCase()));
      if (idx === -1) { await send([header('❗ Not Found'), section(`No project matching "${name}"`)], 'Not found'); return; }
      const removed = projects.splice(idx, 1)[0];
      saveProjects(global.userProjects);
      await send([header('🗑️ Project Deleted'), section(`*"${removed.name}"* removed.`)], 'Deleted');
      return;
    }

    // Unrecognized subcommand
    await send([header('🎵 Project Tracker'), section('`/wavmind project list` — All projects\n`/wavmind project add [name]` — New project\n`/wavmind project update [name] | [note]` — Add note\n`/wavmind project done [name]` — Mark complete')], 'Projects');
    return;
  }

  // ── GENERAL FALLBACK ──────────────────────────────────
  const r = await askAI(`You are Wavmind, expert AI for music producers. Answer: "${input}"`);
  await send([header('🎛️ Wavmind'), section(r || 'Error'), ctx('Type `/wavmind` for all features')], 'Wavmind');
});

// ─── START ────────────────────────────────────────────────
(async () => {
  await app.start();
  console.log('🎛️ Wavmind is running!');
  startMCPServer();
  startScheduler(app.client);
})();
