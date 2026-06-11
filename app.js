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
  if (!vc && vc !== 0) return '—';
  if (vc >= 65) return `${vc}% — Clear ✅`;
  if (vc >= 40) return `${vc}% — Balanced`;
  if (vc >= 20) return `${vc}% — Needs boost`;
  return `${vc}% — Low presence`;
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
// Different queries per genre for variety each fetch
const RELEASE_POOLS = {
  default:   ['new music 2025','top songs 2025','trending 2025','hits 2025','popular songs 2025','chart 2025'],
  trap:      ['trap 2025','dark trap','trap beats 2025','melodic trap','hard trap 2025'],
  pop:       ['pop 2025','pop hits','top pop songs','viral pop','pop music 2025'],
  rnb:       ['rnb 2025','r&b soul','neo soul 2025','rnb hits','contemporary rnb'],
  hiphop:    ['hip hop 2025','rap 2025','rap hits','new rap','hip hop music 2025'],
  afrobeats: ['afrobeats 2025','afro pop','afropop hits','afrobeats music'],
  drill:     ['drill 2025','uk drill','drill rap','drill music 2025'],
};
const releaseIdx = {};

async function getNewReleases(genre) {
  try {
    const token = await getSpotifyToken();
    const pool = RELEASE_POOLS[genre] || RELEASE_POOLS.default;
    const key  = genre || 'default';
    // Rotate query each call for variety
    releaseIdx[key] = ((releaseIdx[key] ?? -1) + 1) % pool.length;
    const q = pool[releaseIdx[key]];
    // Random offset 0-30 so results differ each time
    const offset = Math.floor(Math.random() * 30);
    const r = await axios.get('https://api.spotify.com/v1/search', {
      headers: { Authorization: `Bearer ${token}` },
      params:  { q, type: 'track', limit: 10, offset, market: 'US' },
      timeout: 10000,
    });
    let tracks = r.data.tracks?.items || [];
    // Fallback: retry without offset if empty
    if (!tracks.length) {
      const fb = await axios.get('https://api.spotify.com/v1/search', {
        headers: { Authorization: `Bearer ${token}` },
        params:  { q, type: 'track', limit: 10, market: 'US' },
        timeout: 10000,
      });
      tracks = fb.data.tracks?.items || [];
    }
    if (!tracks.length) return null;
    // Shuffle for extra variety
    tracks = tracks.sort(() => Math.random() - 0.5);
    return tracks.slice(0, 8).map(t => ({
      name:        t.name,
      artist:      t.artists.map(x => x.name).join(', '),
      album:       t.album?.name || '',
      releaseDate: t.album?.release_date || '',
      url:         t.external_urls?.spotify || '',
      popularity:  t.popularity || 0,
    }));
  } catch (e) {
    console.error('New releases error:', e.message);
    return null;
  }
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
  await client.chat.postMessage({ channel: body.user.id, text: 'Comparison started', blocks: [
    header('🆚 Mix Comparison Started!'),
    section('*Step 1* — Upload YOUR track\n*Step 2* — Upload your REFERENCE track\n\nWavmind compares automatically.'),
    ctx('Cancel: `/wavmind cancel`'),
  ]});
});

app.action('quick_feedback', async ({ body, ack, client }) => {
  await ack();
  await client.chat.postMessage({ channel: body.user.id, text: 'Feedback', blocks: [
    header('🎚️ Get Mix Feedback'),
    section('*Just uploaded audio?*\nType `/wavmind feedback` — Wavmind uses your scan data automatically.\n\n*No upload yet?*\n`/wavmind feedback my beat feels muddy and lacks punch`'),
    ctx('Upload audio first for analysis-based feedback'),
  ]});
});

// ─── SAMPLES BUTTONS ──────────────────────────────────────
function getSamplesMenuBlocks() {
  return [
    header('🎵 Free Samples'),
    section('500,000+ Creative Commons sounds. *Different results every search.*'),
    divider(),
    actions([btn('🥁 Drums', 'samples_drums'), btn('🎹 Piano', 'samples_piano'), btn('🎸 Bass', 'samples_bass'), btn('🎷 Synth', 'samples_synth')]),
    actions([btn('🎸 Guitar', 'samples_guitar'), btn('🎻 Strings', 'samples_strings'), btn('🎤 Vocal', 'samples_vocal'), btn('🌊 Ambient', 'samples_ambient')]),
    ctx('All Creative Commons — free to use in your music'),
  ];
}

app.action('samples_open', async ({ body, ack, client }) => {
  await ack();
  await client.chat.postMessage({ channel: body.user.id, text: 'Samples', blocks: getSamplesMenuBlocks() });
});

['drums','piano','bass','synth','guitar','strings','vocal','ambient'].forEach(genre => {
  app.action(`samples_${genre}`, async ({ body, ack, client }) => {
    await ack();
    const userId = body.user.id;
    await client.chat.postMessage({ channel: userId, text: `Finding ${genre} samples...`, blocks: [header(`🎵 Searching ${genre} samples...`), ctx('⏳ Different results every search')]});
    const sounds = await searchFreesound(genre, userId);
    if (!sounds?.length) {
      await client.chat.postMessage({ channel: userId, text: 'No results', blocks: [header('❗ No Results'), section('Try a different genre.'), actions([btn('← All Genres', 'samples_open')])]});
      return;
    }
    const tip = await askAI(`Producer searching for "${genre}" samples. One quick production tip under 25 words.`);
    const bl = [
      header(`🎵 ${genre.charAt(0).toUpperCase()+genre.slice(1)} Samples`),
      section(`*${sounds.length} sounds found* — Creative Commons · _Run again for different results_`),
      divider(),
    ];
    sounds.slice(0, 6).forEach((s, i) => {
      bl.push(section(`*${i+1}. ${s.name}*\n⏱️ ${s.duration}s · ⭐ ${s.rating}/5 · 📥 ${s.downloads.toLocaleString()}\n📄 ${s.license} · 👤 ${s.username}\n${s.preview ? `🔊 *<${s.preview}|▶ Listen>*     ` : ''}🔗 *<${s.url}|📥 Download>*`));
      if (i < 5) bl.push(divider());
    });
    if (tip) bl.push(divider(), section(`💡 *Tip:* ${tip}`));
    bl.push(divider(), actions([btn('🔄 More Results', `samples_${genre}`), btn('← All Genres', 'samples_open')]));
    await client.chat.postMessage({ channel: userId, text: `${genre} samples`, blocks: bl });
  });
});

// ─── NEW RELEASES BUTTONS ─────────────────────────────────
async function sendReleasesMessage(client, userId, genre) {
  await client.chat.postMessage({ channel: userId, text: 'Fetching...', blocks: [
    header(`🆕 Fetching ${genre ? genre.toUpperCase() : 'Latest'} releases...`), ctx('⏳ Loading')
  ]});
  const releases = await getNewReleases(genre || null);
  if (!releases?.length) {
    await client.chat.postMessage({ channel: userId, text: 'Error', blocks: [
      header('❗ Could not fetch'), section('Spotify may be slow. Try again.'),
      actions([btn('🔄 Retry', 'releases_global')]),
    ]});
    return;
  }
  const title = genre ? `🆕 New ${genre.toUpperCase()} Releases` : '🆕 Latest on Spotify';
  const bl = [header(title), section(`*${releases.length} tracks* — _Different results every time_`), divider()];
  releases.forEach((r, i) => {
    bl.push(section(`*${i+1}. ${r.name}*\n👤 ${r.artist}${r.album ? `  💿 ${r.album}` : ''}  📅 ${r.releaseDate}  🔥 ${r.popularity}%\n🎵 *<${r.url}|▶ Listen on Spotify>*`));
    if (i < releases.length - 1) bl.push(divider());
  });
  bl.push(divider(), actions([
    btn('🎵 Trap',     'releases_trap'),
    btn('🎵 Pop',      'releases_pop'),
    btn('🎵 R&B',      'releases_rnb'),
    btn('🎵 Hip-Hop',  'releases_hiphop'),
  ]), actions([
    btn('🎵 Afrobeats','releases_afrobeats'),
    btn('🎵 Drill',    'releases_drill'),
    btn('🌍 All',      'releases_global'),
    btn('🔄 Refresh',  'releases_refresh'),
  ]));
  await client.chat.postMessage({ channel: userId, text: title, blocks: bl });
}

app.action('releases_global',   async ({ body, ack, client }) => { await ack(); await sendReleasesMessage(client, body.user.id, null); });
app.action('releases_refresh',  async ({ body, ack, client }) => { await ack(); await sendReleasesMessage(client, body.user.id, null); });
app.action('releases_trap',     async ({ body, ack, client }) => { await ack(); await sendReleasesMessage(client, body.user.id, 'trap'); });
app.action('releases_pop',      async ({ body, ack, client }) => { await ack(); await sendReleasesMessage(client, body.user.id, 'pop'); });
app.action('releases_rnb',      async ({ body, ack, client }) => { await ack(); await sendReleasesMessage(client, body.user.id, 'rnb'); });
app.action('releases_hiphop',   async ({ body, ack, client }) => { await ack(); await sendReleasesMessage(client, body.user.id, 'hiphop'); });
app.action('releases_afrobeats',async ({ body, ack, client }) => { await ack(); await sendReleasesMessage(client, body.user.id, 'afrobeats'); });
app.action('releases_drill',    async ({ body, ack, client }) => { await ack(); await sendReleasesMessage(client, body.user.id, 'drill'); });

// ─── COLLAB / REFERENCE / DAW / ARTIST BUTTONS ──────────

// Collab session info button
app.action('collab_open', async ({ body, ack, client }) => {
  await ack();
  await client.chat.postMessage({ channel: body.user.id, text: 'Collab', blocks: [
    header('🤝 Team Collab Sessions'),
    section('Log ideas, notes and decisions with your team. Get an AI summary at any time.'),
    divider(),
    section('*Start a session:*\n`/wavmind collab Dark Trap EP`\n\n*During a session:*\n`/wavmind idea [your idea]`\n`/wavmind note [feedback]`\n`/wavmind decided [decision]`\n`/wavmind summary` — AI overview\n`/wavmind end` — Finish session'),
    ctx('💡 Use this in a shared channel with your team'),
  ]});
});

// Reference analysis buttons
app.action('reference_open', async ({ body, ack, client }) => {
  await ack();
  await client.chat.postMessage({ channel: body.user.id, text: 'Reference', blocks: [
    header('🔍 Reference Track Analysis'),
    section('Get real Spotify audio data + a production blueprint for any song.'),
    divider(),
    actions([
      btn('🎵 Blinding Lights',   'ref_blinding_lights'),
      btn('🎵 Gods Plan',       'ref_gods_plan'),
      btn('🎵 Sicko Mode',        'ref_sicko_mode'),
    ]),
    actions([
      btn('🎵 Essence',           'ref_essence'),
      btn('🎵 Rich Flex',         'ref_rich_flex'),
      btn('🎵 Search Any Song',   'ref_custom'),
    ]),
    ctx('Or type: `/wavmind reference [song name]`'),
  ]});
});

// Pre-built reference buttons for popular tracks
const REF_TRACKS = {
  ref_blinding_lights: 'Blinding Lights The Weeknd',
  ref_gods_plan:       'Gods Plan Drake',
  ref_sicko_mode:      'Sicko Mode Travis Scott',
  ref_essence:         'Essence Wizkid',
  ref_rich_flex:       'Rich Flex Drake 21 Savage',
};
Object.entries(REF_TRACKS).forEach(([actionId, trackName]) => {
  app.action(actionId, async ({ body, ack, client }) => {
    await ack();
    const userId = body.user.id;
    await client.chat.postMessage({ channel: userId, text: 'Analyzing...', blocks: [
      header(`🔍 Analyzing "${trackName}"...`), ctx('⏳ Fetching Spotify data'),
    ]});
    const f = await getTrackFeatures(trackName);
    if (!f) {
      await client.chat.postMessage({ channel: userId, text: 'Not found', blocks: [
        header('❗ Not Found'), section(`Could not find "${trackName}" on Spotify.`),
        actions([btn('🔍 Browse References', 'reference_open')]),
      ]});
      return;
    }
    const ai = await askAI(`How to achieve the sound of ${f.name} by ${f.artist}: BPM ${f.bpm}, Key ${f.key}, Energy ${f.energy}%, Loudness ${f.loudness}dB. Specific techniques and real plugin names.`);
    await client.chat.postMessage({ channel: userId, text: 'Reference', blocks: [
      header(`🎵 ${f.name} — ${f.artist}`),
      divider(),
      section('📊 *Real Spotify Data*'),
      twoCol(`🥁 *BPM*
${f.bpm}`, `🎵 *Key*
${f.key}`),
      twoCol(`⚡ *Energy*
${f.energy}%`, `💃 *Danceability*
${f.danceability}%`),
      twoCol(`🔊 *Loudness*
${f.loudness} dB`, `😊 *Valence*
${f.valence}%`),
      divider(),
      section('🎛️ *How to sound like this:*'),
      section(ai || 'Error generating blueprint.'),
      divider(),
      actions([
        btn('🔍 More References', 'reference_open'),
        btn('🆚 Compare My Track', 'quick_compare'),
      ]),
    ]});
  });
});

app.action('ref_custom', async ({ body, ack, client }) => {
  await ack();
  await client.chat.postMessage({ channel: body.user.id, text: 'Reference', blocks: [
    header('🔍 Search Any Song'),
    section('Type the song + artist name:\\n`/wavmind reference Blinding Lights The Weeknd`\\n`/wavmind reference Gods Plan Drake`\\n`/wavmind reference Essence Wizkid`'),
    ctx('Uses real Spotify data — works for any song'),
  ]});
});

// DAW Help buttons
app.action('daw_open', async ({ body, ack, client }) => {
  await ack();
  await client.chat.postMessage({ channel: body.user.id, text: 'DAW Help', blocks: [
    header('🎸 DAW Help'),
    section('Step-by-step tutorials powered by AI + real-time web search.'),
    divider(),
    actions([
      btn('FL Studio',    'daw_fl_studio'),
      btn('Ableton Live', 'daw_ableton'),
      btn('Logic Pro',    'daw_logic'),
      btn('Pro Tools',    'daw_protools'),
    ]),
    actions([
      btn('Cubase',       'daw_cubase'),
      btn('Studio One',   'daw_studio_one'),
      btn('GarageBand',   'daw_garageband'),
      btn('Reaper',       'daw_reaper'),
    ]),
    ctx('Or type: `/wavmind daw [daw name] [your question]`'),
  ]});
});

const DAW_MAP = { daw_fl_studio:'FL Studio', daw_ableton:'Ableton Live', daw_logic:'Logic Pro', daw_protools:'Pro Tools', daw_cubase:'Cubase', daw_studio_one:'Studio One', daw_garageband:'GarageBand', daw_reaper:'Reaper' };
Object.entries(DAW_MAP).forEach(([actionId, dawName]) => {
  app.action(actionId, async ({ body, ack, client }) => {
    await ack();
    await client.chat.postMessage({ channel: body.user.id, text: 'DAW Help', blocks: [
      header(`🎸 ${dawName} Help`),
      section(`What do you want to learn in *${dawName}*?

Type your question:
\`/wavmind daw ${dawName.toLowerCase()} how to sidechain kick\`
\`/wavmind daw ${dawName.toLowerCase()} set up reverb send\`
\`/wavmind daw ${dawName.toLowerCase()} mix bus chain\``),
      ctx(`AI answer + real web results for every question`),
    ]});
  });
});

// Artist Compare buttons
app.action('artist_open', async ({ body, ack, client }) => {
  await ack();
  await client.chat.postMessage({ channel: body.user.id, text: 'Artist Compare', blocks: [
    header('🎤 Artist DNA Comparison'),
    section('Compare two artists using real Spotify audio data — BPM, energy, key, loudness and more.'),
    divider(),
    actions([
      btn('Drake vs Travis Scott',    'artist_drake_travis'),
      btn('Wizkid vs Burna Boy',      'artist_wizkid_burna'),
      btn('Kanye vs Tyler',           'artist_kanye_tyler'),
    ]),
    actions([
      btn('The Weeknd vs Frank Ocean','artist_weeknd_frank'),
      btn('Eminem vs Kendrick',       'artist_eminem_kendrick'),
      btn('Compare Custom',           'artist_custom'),
    ]),
    ctx('Or type: `/wavmind artist [artist1] and [artist2]`'),
  ]});
});

const ARTIST_PAIRS = {
  artist_drake_travis:    ['Drake',      'Travis Scott'],
  artist_wizkid_burna:    ['Wizkid',     'Burna Boy'],
  artist_kanye_tyler:     ['Kanye West', 'Tyler the Creator'],
  artist_weeknd_frank:    ['The Weeknd', 'Frank Ocean'],
  artist_eminem_kendrick: ['Eminem',     'Kendrick Lamar'],
};
Object.entries(ARTIST_PAIRS).forEach(([actionId, [a1, a2]]) => {
  app.action(actionId, async ({ body, ack, client }) => {
    await ack();
    const userId = body.user.id;
    await client.chat.postMessage({ channel: userId, text: 'Comparing...', blocks: [
      header(`🎤 ${a1} vs ${a2}`), ctx('⏳ Fetching Spotify data for both artists'),
    ]});
    const [s1, s2] = await Promise.all([getArtistStats(a1), getArtistStats(a2)]);
    if (!s1 || !s2) {
      await client.chat.postMessage({ channel: userId, text: 'Error', blocks: [header('❗ Could not fetch'), section('Try again shortly.')]});
      return;
    }
    const ai = await askAI(`Compare production styles: ${s1.name} (BPM ${s1.bpm}, Energy ${s1.energy}%, Key ${s1.key}, Loudness ${s1.loudness}dB) vs ${s2.name} (BPM ${s2.bpm}, Energy ${s2.energy}%, Key ${s2.key}, Loudness ${s2.loudness}dB). Key differences and how to blend both styles.`);
    await client.chat.postMessage({ channel: userId, text: 'Artist Compare', blocks: [
      header(`🎤 ${s1.name} vs ${s2.name}`),
      divider(),
      section('📊 *Real Spotify Data*'),
      { type:'section', fields:[{type:'mrkdwn',text:`*${s1.name}*`},{type:'mrkdwn',text:`*${s2.name}*`}] },
      { type:'section', fields:[{type:'mrkdwn',text:`🥁 BPM: *${s1.bpm}*`},{type:'mrkdwn',text:`🥁 BPM: *${s2.bpm}*`}] },
      { type:'section', fields:[{type:'mrkdwn',text:`⚡ Energy: *${s1.energy}%*`},{type:'mrkdwn',text:`⚡ Energy: *${s2.energy}%*`}] },
      { type:'section', fields:[{type:'mrkdwn',text:`🔊 Loud: *${s1.loudness}dB*`},{type:'mrkdwn',text:`🔊 Loud: *${s2.loudness}dB*`}] },
      { type:'section', fields:[{type:'mrkdwn',text:`🎵 Key: *${s1.key}*`},{type:'mrkdwn',text:`🎵 Key: *${s2.key}*`}] },
      divider(),
      section(ai || 'Error'),
      divider(),
      actions([btn('🎤 Compare Others', 'artist_open'), btn('🔍 Reference Track', 'reference_open')]),
    ]});
  });
});

app.action('artist_custom', async ({ body, ack, client }) => {
  await ack();
  await client.chat.postMessage({ channel: body.user.id, text: 'Artist Compare', blocks: [
    header('🎤 Compare Any Two Artists'),
    section('Type both artist names:\n`/wavmind artist Drake and Travis Scott`\n`/wavmind artist Wizkid and Burna Boy`\n`/wavmind artist The Weeknd and Frank Ocean`'),
  ]});
});

// ─── DAW GURU BUTTON HANDLERS ────────────────────────────
const DAW_BUTTONS   = ['FL Studio','Ableton Live','Logic Pro','Pro Tools','Cubase','Studio One','GarageBand','Reaper','Bitwig'];
const LEVEL_BUTTONS = ['beginner','intermediate','advanced','professional'];
const FOCUS_BUTTONS = ['mixing','sound_design','arrangement','beat_making','mastering','melody','bass_design','general'];

function getGuruDAWBlocks() {
  return [
    header('🎓 Welcome to DAW Guru!'),
    section('Your personal AI music tutor. Get *daily personalized lessons* based on your DAW and skill level — sent to your DMs every morning.\n\n*Step 1 — Which DAW do you use?*'),
    divider(),
    actions(DAW_BUTTONS.slice(0,4).map(d => btn(d, `guru_daw_${d.toLowerCase().replace(/ /g,'_')}`))),
    actions(DAW_BUTTONS.slice(4).map(d => btn(d, `guru_daw_${d.toLowerCase().replace(/ /g,'_')}`))),
    ctx('🎓 Tap your DAW to continue'),
  ];
}
function getGuruLevelBlocks(daw) {
  return [
    header(`🎓 ${daw} ✅`),
    section('*Step 2 — What is your skill level?*'),
    divider(),
    actions([btn('🌱 Beginner', 'guru_level_beginner'), btn('🎚️ Intermediate', 'guru_level_intermediate')]),
    actions([btn('🔥 Advanced', 'guru_level_advanced'), btn('🏆 Professional', 'guru_level_professional')]),
    ctx('Beginner = learning basics · Intermediate = making beats · Advanced = pro techniques · Professional = studio level'),
  ];
}
function getGuruFocusBlocks(daw, level) {
  const li = DAW_LEVELS[level] || DAW_LEVELS.intermediate;
  return [
    header(`🎓 ${daw} · ${li.emoji} ${li.label} ✅`),
    section('*Step 3 — What is your main focus?*\n_This personalizes every lesson_'),
    divider(),
    actions([btn('🎚️ Mixing', 'guru_focus_mixing'), btn('🎛️ Sound Design', 'guru_focus_sound_design'), btn('🎼 Arrangement', 'guru_focus_arrangement'), btn('🥁 Beat Making', 'guru_focus_beat_making')]),
    actions([btn('🔊 Mastering', 'guru_focus_mastering'), btn('🎹 Melody', 'guru_focus_melody'), btn('🎸 Bass Design', 'guru_focus_bass_design'), btn('🎵 General', 'guru_focus_general')]),
  ];
}
function getGuruActiveBlocks(p) {
  const li = DAW_LEVELS[p.level] || DAW_LEVELS.intermediate;
  return [
    header('🎓 DAW Guru — Active'),
    twoCol(`🎛️ *DAW*\n${p.daw}`, `${li.emoji} *Level*\n${li.label}`),
    twoCol(`🎯 *Focus*\n${p.style || 'General'}`, `📖 *Lessons*\n${p.tipsCount || 0} received`),
    divider(),
    actions([btn('🎓 Get Lesson Now', 'guru_tip_now', 'primary'), btn('⚙️ Change Settings', 'guru_restart'), btn('⏸️ Pause', 'guru_stop')]),
    ctx('Daily lessons sent every morning at 9am'),
  ];
}

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

FOCUS_BUTTONS.forEach(focus => {
  app.action(`guru_focus_${focus}`, async ({ body, ack, client }) => {
    await ack();
    const userId = body.user.id;
    if (!global.dawGuruProfiles[userId]) global.dawGuruProfiles[userId] = {};
    const style = focus.replace(/_/g, ' ');
    global.dawGuruProfiles[userId].style = style;
    saveDawGuru(global.dawGuruProfiles);
    const p = global.dawGuruProfiles[userId];
    const li = DAW_LEVELS[p.level] || DAW_LEVELS.intermediate;
    await client.chat.postMessage({ channel: userId, text: 'DAW Guru', blocks: [
      header('🎓 DAW Guru — All Set!'),
      twoCol(`🎛️ *DAW*\n${p.daw}`, `${li.emoji} *Level*\n${li.label}`),
      twoCol(`🎯 *Focus*\n${style}`, `📅 *Lessons*\nEvery morning at 9am`),
      divider(),
      section('Daily lessons will arrive in your DMs every morning automatically. Get your first one now:'),
      actions([btn('🎓 Get First Lesson', 'guru_tip_now', 'primary')]),
    ]});
  });
});

app.action('guru_tip_now', async ({ body, ack, client }) => {
  await ack();
  const userId = body.user.id;
  const p = global.dawGuruProfiles[userId];
  if (!p?.daw || !p?.level) { await client.chat.postMessage({ channel: userId, text: 'Setup', blocks: getGuruDAWBlocks() }); return; }
  await client.chat.postMessage({ channel: userId, text: 'Loading...', blocks: [header(`🎓 Generating your ${p.daw} lesson...`), ctx('⏳')]});
  const tip = await getDawGuruTip(p.daw, p.level, p.style);
  const li = DAW_LEVELS[p.level] || DAW_LEVELS.intermediate;
  global.dawGuruProfiles[userId].tipsCount = (p.tipsCount || 0) + 1;
  global.dawGuruProfiles[userId].lastTip = new Date().toISOString();
  saveDawGuru(global.dawGuruProfiles);
  await client.chat.postMessage({ channel: userId, text: 'Lesson', blocks: [
    header(`🎓 ${p.daw} — ${li.emoji} ${li.label}`),
    ...(p.style && p.style !== 'general' ? [section(`🎯 *Focus: ${p.style}*`)] : []),
    divider(),
    section(tip || 'Could not generate lesson. Try again.'),
    divider(),
    actions([btn('🎓 Another Lesson', 'guru_tip_now'), btn('⚙️ Settings', 'guru_status')]),
    ctx(`Lesson ${global.dawGuruProfiles[userId].tipsCount} · Daily at 9am`),
  ]});
});

app.action('guru_open', async ({ body, ack, client }) => {
  await ack();
  const userId = body.user.id;
  const p = global.dawGuruProfiles[userId];
  if (!p?.daw || !p?.level) { await client.chat.postMessage({ channel: userId, text: 'DAW Guru', blocks: getGuruDAWBlocks() }); return; }
  await client.chat.postMessage({ channel: userId, text: 'DAW Guru', blocks: getGuruActiveBlocks(p) });
});

app.action('guru_status', async ({ body, ack, client }) => {
  await ack();
  const userId = body.user.id;
  const p = global.dawGuruProfiles[userId];
  if (!p?.daw || !p?.level) { await client.chat.postMessage({ channel: userId, text: 'Setup', blocks: getGuruDAWBlocks() }); return; }
  await client.chat.postMessage({ channel: userId, text: 'Status', blocks: getGuruActiveBlocks(p) });
});

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

app.action('guru_resume', async ({ body, ack, client }) => {
  await ack();
  const userId = body.user.id;
  if (global.dawGuruProfiles[userId]) { global.dawGuruProfiles[userId].paused = false; saveDawGuru(global.dawGuruProfiles); }
  const p = global.dawGuruProfiles[userId] || {};
  await client.chat.postMessage({ channel: userId, text: 'Resumed', blocks: getGuruActiveBlocks(p) });
});

app.action('guru_restart', async ({ body, ack, client }) => {
  await ack();
  const userId = body.user.id;
  delete global.dawGuruProfiles[userId];
  saveDawGuru(global.dawGuruProfiles);
  await client.chat.postMessage({ channel: userId, text: 'DAW Guru', blocks: getGuruDAWBlocks() });
});

// ─── PROJECT TRACKER BUTTONS ──────────────────────────────
app.action('project_list', async ({ body, ack, client }) => {
  await ack();
  const userId = body.user.id;
  const projects = global.userProjects[userId] || [];
  const active = projects.filter(p => !p.done);
  const done = projects.filter(p => p.done);
  if (!projects.length) {
    await client.chat.postMessage({ channel: userId, text: 'Projects', blocks: [
      header('📌 No Projects Yet'),
      section('Track your music projects and get daily reminders to keep making progress.'),
      actions([btn('➕ Add Your First Project', 'project_add_prompt', 'primary')]),
    ]});
    return;
  }
  const bl = [header(`📌 Your Projects`), divider()];
  if (active.length) {
    bl.push(section(`*${active.length} In Progress*`));
    active.forEach(p => {
      const days = Math.floor((Date.now() - new Date(p.createdAt)) / (1000*60*60*24));
      const lastNote = p.notes?.slice(-1)[0]?.text;
      bl.push(section(`🎵 *${p.name}*\n📅 Day ${days}${lastNote ? `\n📝 _${lastNote}_` : ''}`));
    });
  }
  if (done.length) {
    bl.push(divider(), section(`*${done.length} Completed ✅*`));
    done.slice(-3).forEach(p => bl.push(section(`✅ *${p.name}*`)));
  }
  bl.push(divider(), actions([btn('➕ Add Project', 'project_add_prompt', 'primary'), btn('🔄 Refresh', 'project_list')]));
  await client.chat.postMessage({ channel: userId, text: 'Projects', blocks: bl });
});

app.action('project_add_prompt', async ({ body, ack, client }) => {
  await ack();
  const userId = body.user.id;
  await client.chat.postMessage({ channel: userId, text: 'Add Project', blocks: [
    header('➕ Add a Project'),
    section('Type the name of your track or project:'),
    section('`/wavmind project add Dark Trap EP`\n`/wavmind project add Summer Vibes Beat`\n`/wavmind project add Collab with Ahmed`'),
    ctx('You will get daily reminders until you mark it done'),
  ]});
});

// ─── APP HOME ─────────────────────────────────────────────
async function publishAppHome(client, userId) {
  try {
    const uploads  = global.userUploads[userId]  || [];
    const last     = uploads[uploads.length - 1];
    const stats    = global.weeklyStats[userId];
    const guru     = global.dawGuruProfiles[userId];
    const projects = (global.userProjects[userId] || []).filter(p => !p.done);
    const blocks   = [];

    // HERO
    blocks.push(section('*🎛️ Wavmind*  —  _AI Music Production Agent_'));
    blocks.push(actions([
      btn('🆕 New Releases',   'releases_global'),
      btn('🎓 DAW Guru',       'guru_open'),
      btn('📌 Projects',       'project_list'),
    ]));
    blocks.push(actions([
      btn('🆚 Compare Tracks', 'quick_compare', 'primary'),
      btn('🎵 Free Samples',   'samples_open'),
      btn('🎚️ Mix Feedback',  'quick_feedback'),
    ]));
    blocks.push(actions([
      btn('🔍 Reference Track','reference_open'),
      btn('🎤 Artist Compare', 'artist_open'),
      btn('🎸 DAW Help',       'daw_open'),
      btn('🤝 Collab',         'collab_open'),
    ]));
    blocks.push(divider());

    // LAST SCAN
    if (last?.analysis && !last.analysis.error) {
      const a = last.analysis;
      blocks.push(header('🎵 Last Track Scanned'));
      blocks.push(section(`*${last.filename}*\n_${new Date(last.timestamp).toLocaleDateString()}_`));
      if (a.lufs !== undefined) {
        const vcLabel = a.vocal_clarity >= 65 ? 'Clear ✅' : a.vocal_clarity >= 40 ? 'Balanced' : 'Needs boost';
        blocks.push(twoCol(`🔊 *Loudness*\n${loudnessLabel(a.lufs)}`, `🎚️ *Stereo*\n${a.stereo_width}% ${a.stereo_width < 15 ? '— Narrow' : a.stereo_width > 50 ? '— Wide ✅' : '— Normal'}`));
        blocks.push(twoCol(`🎤 *Vocals*\n${a.vocal_clarity}% — ${vcLabel}`, `⚡ *Energy*\n${a.energy}%`));
      } else {
        blocks.push(twoCol(`⚡ *Energy*\n${a.energy}%`, `🌈 *Brightness*\n${a.brightness}`));
      }
      blocks.push(actions([btn('🆚 Compare', 'quick_compare', 'primary'), btn('🎚️ Feedback', 'quick_feedback')]));
      blocks.push(divider());
    }

    // DAW GURU CARD
    if (guru?.daw && guru?.level) {
      const li = DAW_LEVELS[guru.level] || DAW_LEVELS.intermediate;
      blocks.push(header('🎓 DAW Guru'));
      blocks.push(twoCol(`🎛️ *${guru.daw}*\n${li.emoji} ${li.label}`, `🎯 *${guru.style || 'General'}*\n📖 ${guru.tipsCount || 0} lessons`));
      blocks.push(actions([btn('🎓 Get Today\'s Lesson', 'guru_tip_now', 'primary'), btn(guru.paused ? '▶️ Resume' : '⚙️ Settings', guru.paused ? 'guru_resume' : 'guru_status')]));
    } else {
      blocks.push(header('🎓 DAW Guru'));
      blocks.push(section('Daily personalized lessons for your DAW and skill level — sent automatically every morning.'));
      blocks.push(actions([btn('🎓 Set Up DAW Guru', 'guru_open', 'primary')]));
    }
    blocks.push(divider());

    // PROJECTS CARD
    blocks.push(header('📌 Projects'));
    if (projects.length) {
      projects.slice(0, 3).forEach(p => {
        const days = Math.floor((Date.now() - new Date(p.createdAt)) / (1000*60*60*24));
        blocks.push(section(`🎵 *${p.name}*  —  Day ${days}${p.notes?.slice(-1)[0] ? `\n📝 _${p.notes.slice(-1)[0].text}_` : ''}`));
      });
      if (projects.length > 3) blocks.push(ctx(`_+${projects.length-3} more active projects_`));
      blocks.push(actions([btn('➕ Add Project', 'project_add_prompt'), btn('📋 View All', 'project_list')]));
    } else {
      blocks.push(section('Track your music projects and get daily reminders.'));
      blocks.push(actions([btn('➕ Start a Project', 'project_add_prompt', 'primary')]));
    }
    blocks.push(divider());

    // WEEKLY STATS
    if (stats?.tracks > 0) {
      blocks.push(header('📈 This Week'));
      blocks.push(twoCol(`🎵 *${stats.tracks}* tracks scanned`, `⚠️ *Top issue:* ${stats.issues[0] || 'None'}`));
      blocks.push(divider());
    }

    // CAPABILITIES
    blocks.push(header('⚡ What Can Wavmind Do?'));
    blocks.push(twoCol('*🆚 Compare Tracks*\nYour mix vs reference → side-by-side gap analysis + AI fix plan', '*🎵 Free Samples*\n500K+ Creative Commons sounds · Different every search'));
    blocks.push(twoCol('*🎤 Artist DNA*\nCompare two artists using real Spotify data\n`/wavmind artist Drake and Travis Scott`', '*🎸 DAW Help*\nStep-by-step tutorials via AI + real-time web search'));
    blocks.push(twoCol('*🤝 Collab Sessions*\nLog ideas, notes and decisions as a team · AI summary', '*🔍 Reference Analysis*\nReal Spotify audio features + production blueprint'));
    blocks.push(divider());

    // AUTONOMOUS
    blocks.push(header('🤖 Running 24/7 For You'));
    blocks.push(twoCol('⏰ *24hr Reminders*\nUpload a track → DM follow-up the next day', '📊 *Weekly Reports*\nEvery Monday: stats, issues, tips'));
    blocks.push(twoCol('🎓 *Daily Lessons*\nDAW Guru at 9am every morning', '📌 *Project Reminders*\nDaily nudges at 10am on active projects'));
    blocks.push(divider());

    blocks.push(ctx('⚡ Groq AI · Spotify · Tavily · Freesound 500K+ · Librosa · pyloudnorm · MCP v2.0'));

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
      bl.push(twoCol(`🔊 *Loudness*\n${loudnessLabel(a.lufs)}`, `🎚️ *Stereo Width*\n${a.stereo_width}%`));
      bl.push(twoCol(`📊 *Low / Mid / High*\n${a.low_pct}% / ${a.mid_pct}% / ${a.high_pct}%`, `🎤 *Vocal Clarity*\n${a.vocal_clarity}%`));
      bl.push(twoCol(`⚡ *Energy*\n${a.energy}%`, `🌈 *Brightness*\n${a.brightness}`));
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

    bl.push(divider(), section('*What next?*'), actions([btn('🎚️ Get Mix Feedback', 'quick_feedback', 'primary'), btn('🆚 Compare with Reference', 'quick_compare')]), ctx('🤖 I\'ll DM you a follow-up reminder tomorrow'));
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
    await respond({ response_type: 'in_channel', text: 'Collab started', blocks: [
      header('🤝 Collab Session Started'),
      section(`*Track:* "${name}"\n*By:* <@${userId}>`),
      divider(),
      section('`/wavmind idea [idea]` — Log an idea\n`/wavmind note [feedback]` — Log feedback\n`/wavmind decided [decision]` — Log a decision\n`/wavmind summary` — AI summary\n`/wavmind end` — End session'),
      ctx(`Session active for "${name}"`),
    ]});
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
    await respond({ response_type:'in_channel', text:'Note logged', blocks:[header('📝 Note Logged'),section(`*"${t}"*\n— <@${userId}>`),ctx(`${s.feedback.length} notes for "${s.trackName()}"`)] });
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
    const releases = await getNewReleases(genre || null);
    if (!releases?.length) { await send([header('❗ Could not fetch'), section('Try again shortly.')], 'Error'); return; }
    const bl = [header(`🆕 New Releases${genre ? ` — ${genre}` : ''}`), section(`*${releases.length} fresh tracks* — _Different results every time_`), divider()];
    releases.forEach((rel, i) => {
      bl.push(section(`*${i+1}. ${rel.name}*\n👤 ${rel.artist}${rel.album ? `  💿 ${rel.album}` : ''}  📅 ${rel.releaseDate}  🔥 ${rel.popularity}%\n🎵 *<${rel.url}|▶ Listen on Spotify>*`));
      if (i < releases.length - 1) bl.push(divider());
    });
    bl.push(divider(), actions([
      btn('🎵 Trap', 'releases_trap'), btn('🎵 Pop', 'releases_pop'),
      btn('🎵 R&B', 'releases_rnb'), btn('🔄 Refresh', 'releases_refresh'),
    ]));
    await send(bl, 'New Releases');
    return;
  }

  // ── DAW GURU COMMAND ──────────────────────────────────
  const isGuruCmd = lower.startsWith('dawguru') || lower.startsWith('daw guru') || lower.startsWith('guru');
  if (isGuruCmd) {
    const p = global.dawGuruProfiles[userId] || {};
    if (!p.daw || !p.level) {
      await respond({ text: 'DAW Guru', blocks: getGuruDAWBlocks() });
    } else if (!p.style) {
      await respond({ text: 'DAW Guru', blocks: getGuruFocusBlocks(p.daw, p.level) });
    } else {
      await respond({ text: 'DAW Guru', blocks: getGuruActiveBlocks(p) });
    }
    return;
  }

  // ── PROJECT TRACKER ───────────────────────────────────
  if (lower.startsWith('project')) {
    const sub = input.slice(7).trim();
    const subL = sub.toLowerCase();
    if (!subL || subL === 'list' || subL === 'all') {
      const projects = global.userProjects[userId] || [];
      if (!projects.length) {
        await send([header('📌 Project Tracker'), section('No projects yet.'), actions([btn('➕ Add Project', 'project_add_prompt', 'primary')])], 'Projects');
        return;
      }
      const active = projects.filter(p => !p.done);
      const bl = [header(`📌 Projects (${projects.length})`), divider()];
      active.forEach(p => {
        const age = Math.floor((Date.now() - new Date(p.createdAt)) / (1000*60*60*24));
        const lastNote = p.notes?.slice(-1)[0]?.text;
        bl.push(section(`🎵 *${p.name}*\n📅 Day ${age} · In Progress${lastNote ? `\n📝 _${lastNote}_` : ''}`));
      });
      bl.push(divider(), actions([btn('➕ Add Project', 'project_add_prompt', 'primary'), btn('🔄 Refresh', 'project_list')]));
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
        header('📌 Project Added'),
        section(`*"${name}"* is now being tracked.\n\nWavmind will DM you daily reminders to keep making progress.`),
        actions([btn('📋 View All Projects', 'project_list')]),
      ], 'Added');
      if (userId) { try { await publishAppHome(client, userId); } catch(e){} }
      return;
    }
    if (subL.startsWith('done ')) {
      const name = sub.slice(5).trim();
      const projects = global.userProjects[userId] || [];
      const proj = projects.find(p => p.name.toLowerCase().includes(name.toLowerCase()));
      if (!proj) { await send([header('❗ Not Found'), section(`No project matching "${name}"`)], 'Not found'); return; }
      proj.done = true; proj.completedAt = new Date().toISOString();
      saveProjects(global.userProjects);
      const days = Math.floor((Date.now() - new Date(proj.createdAt)) / (1000*60*60*24));
      await send([header('🏆 Project Complete!'), section(`*"${proj.name}"* — finished in *${days} days*! 🎉`), actions([btn('➕ New Project', 'project_add_prompt', 'primary'), btn('📋 All Projects', 'project_list')])], 'Done');
      if (userId) { try { await publishAppHome(client, userId); } catch(e){} }
      return;
    }
    if (subL.startsWith('update ')) {
      const parts = sub.slice(7).split('|');
      const name = parts[0]?.trim(), note = parts[1]?.trim();
      if (!name || !note) { await send([header('❗ Format'), section('`/wavmind project update My EP | Finished the drums`')], 'Format'); return; }
      const projects = global.userProjects[userId] || [];
      const proj = projects.find(p => p.name.toLowerCase().includes(name.toLowerCase()));
      if (!proj) { await send([header('❗ Not Found'), section(`No project matching "${name}"`)], 'Not found'); return; }
      if (!proj.notes) proj.notes = [];
      proj.notes.push({ text: note, time: new Date().toISOString() });
      proj.lastUpdated = new Date().toISOString();
      saveProjects(global.userProjects);
      await send([header('📝 Progress Logged'), section(`*"${proj.name}"*\n📝 ${note}`), actions([btn('📋 All Projects', 'project_list')])], 'Updated');
      return;
    }
    if (subL.startsWith('delete ') || subL.startsWith('remove ')) {
      const name = sub.slice(7).trim();
      const projects = global.userProjects[userId] || [];
      const idx = projects.findIndex(p => p.name.toLowerCase().includes(name.toLowerCase()));
      if (idx === -1) { await send([header('❗ Not Found'), section(`No project matching "${name}"`)], 'Not found'); return; }
      const removed = projects.splice(idx, 1)[0];
      saveProjects(global.userProjects);
      await send([header('🗑️ Deleted'), section(`*"${removed.name}"* removed.`)], 'Deleted');
      return;
    }
    await send([header('📌 Project Tracker'), section('`/wavmind project add [name]`\n`/wavmind project list`\n`/wavmind project update [name] | [note]`\n`/wavmind project done [name]`')], 'Projects');
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
