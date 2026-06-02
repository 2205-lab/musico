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

// ─── PERSISTENT STORAGE ───────────────────────────────────
const REMINDERS_FILE = '/tmp/wavmind_reminders.json';
const STATS_FILE = '/tmp/wavmind_stats.json';

function loadReminders() {
  try { if (fs.existsSync(REMINDERS_FILE)) return JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8')); }
  catch (err) { console.error('Load reminders error:', err.message); }
  return {};
}

function saveReminders(data) {
  try { fs.writeFileSync(REMINDERS_FILE, JSON.stringify(data, null, 2)); }
  catch (err) { console.error('Save reminders error:', err.message); }
}

function loadStats() {
  try { if (fs.existsSync(STATS_FILE)) return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); }
  catch (err) { console.error('Load stats error:', err.message); }
  return {};
}

function saveStats(data) {
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(data, null, 2)); }
  catch (err) { console.error('Save stats error:', err.message); }
}

global.pendingReminders = loadReminders();
global.weeklyStats = loadStats();
global.userUploads = global.userUploads || {};

// Track last page per query per user so we never repeat
global.samplePageTracker = global.samplePageTracker || {};

function getNextPage(userId, query) {
  const key = `${userId}_${query.toLowerCase().trim()}`;
  if (!global.samplePageTracker[key]) global.samplePageTracker[key] = [];
  const used = global.samplePageTracker[key];
  // Pick random page 1-8 that hasn't been used recently
  let attempts = 0;
  let page;
  do {
    page = Math.floor(Math.random() * 8) + 1;
    attempts++;
  } while (used.includes(page) && attempts < 20);
  // Keep only last 6 used pages so they eventually cycle back
  used.push(page);
  if (used.length > 6) used.shift();
  global.samplePageTracker[key] = used;
  return page;
}

function trackUpload(userId, filename, analysis) {
  if (!global.pendingReminders[userId]) global.pendingReminders[userId] = [];
  global.pendingReminders[userId].push({
    filename, analysis,
    uploadedAt: new Date().toISOString(),
    remindAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    sent: false,
  });
  saveReminders(global.pendingReminders);
  if (!global.userUploads[userId]) global.userUploads[userId] = [];
  global.userUploads[userId].push({ filename, analysis, timestamp: new Date().toISOString() });
  if (!global.weeklyStats[userId]) global.weeklyStats[userId] = { tracks: 0, issues: [] };
  global.weeklyStats[userId].tracks++;
  if (analysis.energy < 50) global.weeklyStats[userId].issues.push('Low energy');
  if (analysis.bass_ratio > 65) global.weeklyStats[userId].issues.push('Heavy bass');
  if (analysis.bass_ratio < 20) global.weeklyStats[userId].issues.push('Thin bass');
  saveStats(global.weeklyStats);
}

// ─── GROQ AI ─────────────────────────────────────────────
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

// ─── TAVILY ──────────────────────────────────────────────
async function tavilySearch(query) {
  try {
    const res = await axios.post('https://api.tavily.com/search',
      { api_key: process.env.TAVILY_API_KEY, query, search_depth: 'basic', max_results: 5, include_answer: true },
      { timeout: 10000 }
    );
    return { answer: res.data.answer || null, results: (res.data.results || []).map(r => ({ title: r.title, url: r.url })) };
  } catch (err) { console.error('Tavily error:', err.message); return null; }
}

// ─── FREESOUND ────────────────────────────────────────────
// Maps raw Freesound results to clean objects
function mapSounds(results) {
  return results
    .sort(() => Math.random() - 0.5) // shuffle so order varies
    .map(s => ({
      id: s.id,
      name: s.name,
      duration: Math.round((s.duration || 0) * 10) / 10,
      license: s.license?.includes('publicdomain') ? 'CC0 — Free' :
               s.license?.includes('by/3.0') || s.license?.includes('by/4.0') ? 'CC Attribution' :
               'Creative Commons',
      username: s.username,
      preview: s.previews?.['preview-hq-mp3'] || s.previews?.['preview-lq-mp3'] || null,
      url: `https://freesound.org/people/${s.username}/sounds/${s.id}/`,
      downloads: s.num_downloads || 0,
      rating: s.avg_rating ? Math.round(s.avg_rating * 10) / 10 : 0,
      tags: (s.tags || []).slice(0, 6).join(' · '),
    }));
}

// Smart query builder — keeps meaningful words, expands short queries
function buildSearchQuery(query) {
  // Words to remove
  const stopWords = /\b(loop|loops|sample|samples|pack|packs|free|download|audio)\b/gi;
  // Keep BPM numbers as they help specificity
  let clean = query.replace(stopWords, '').trim();
  // Collapse multiple spaces
  clean = clean.replace(/\s+/g, ' ').trim();
  // If too short after cleaning use original
  if (clean.length < 2) clean = query.trim();
  return clean;
}

// Instrument-specific search enhancers
function enhanceQuery(query) {
  const lower = query.toLowerCase();
  const enhancements = {
    piano: ['piano melody', 'piano chord', 'piano loop', 'piano riff', 'piano notes'],
    synth: ['synth pad', 'synth lead', 'synth bass', 'synthesizer', 'synth arp'],
    bass: ['bass guitar', 'bass line', 'bass riff', '808 bass', 'sub bass'],
    guitar: ['guitar riff', 'guitar chord', 'electric guitar', 'acoustic guitar', 'guitar loop'],
    drums: ['drum loop', 'drum beat', 'drum kit', 'trap drums', 'drum pattern'],
    strings: ['string ensemble', 'violin', 'cello', 'string melody', 'orchestral strings'],
    flute: ['flute melody', 'flute loop', 'pan flute', 'flute notes'],
    trumpet: ['trumpet melody', 'brass', 'trumpet loop', 'trumpet riff'],
    saxophone: ['saxophone jazz', 'sax melody', 'alto sax', 'saxophone riff'],
    violin: ['violin melody', 'violin loop', 'violin solo', 'string violin'],
    keys: ['keyboard melody', 'electric piano', 'rhodes', 'organ keys'],
    harp: ['harp melody', 'harp arp', 'harp glissando'],
    ambient: ['ambient pad', 'ambient texture', 'ambient drone', 'ambient atmosphere'],
    vocal: ['vocal chop', 'vocal sample', 'vocal melody', 'vocal harmony', 'acapella'],
    horn: ['french horn', 'horn melody', 'brass horn', 'horn loop'],
  };
  for (const [instrument, options] of Object.entries(enhancements)) {
    if (lower.includes(instrument)) {
      // Pick random enhancement to vary results
      return options[Math.floor(Math.random() * options.length)];
    }
  }
  return query;
}

async function searchFreesound(query, userId = null) {
  try {
    const cleanQuery = buildSearchQuery(query);
    const enhancedQuery = enhanceQuery(cleanQuery);

    // Get next non-repeated page for this user+query combo
    const page = userId ? getNextPage(userId, query) : Math.floor(Math.random() * 8) + 1;

    console.log(`🎵 Freesound search: "${enhancedQuery}" page ${page}`);

    const url = `https://freesound.org/apiv2/search/text/?query=${encodeURIComponent(enhancedQuery)}&token=${process.env.FREESOUND_API_KEY}&format=json&page_size=10&page=${page}&fields=id,name,tags,duration,license,username,previews,avg_rating,num_downloads&filter=duration:[1+TO+30]`;
    const res = await axios.get(url, { timeout: 10000 });
    let results = res.data.results || [];

    // If page is empty fall back to page 1 with original query
    if (!results.length && page > 1) {
      console.log(`🔄 Page ${page} empty, falling back to page 1`);
      const fallbackUrl = `https://freesound.org/apiv2/search/text/?query=${encodeURIComponent(cleanQuery)}&token=${process.env.FREESOUND_API_KEY}&format=json&page_size=10&page=1&fields=id,name,tags,duration,license,username,previews,avg_rating,num_downloads&filter=duration:[1+TO+30]`;
      const fallback = await axios.get(fallbackUrl, { timeout: 10000 });
      results = fallback.data.results || [];
    }

    // If still empty try simplified single word
    if (!results.length) {
      const simpleQuery = query.split(' ')[0];
      if (simpleQuery !== query) {
        console.log(`🔄 Trying simplified query: "${simpleQuery}"`);
        const simpleUrl = `https://freesound.org/apiv2/search/text/?query=${encodeURIComponent(simpleQuery)}&token=${process.env.FREESOUND_API_KEY}&format=json&page_size=10&page=1&fields=id,name,tags,duration,license,username,previews,avg_rating,num_downloads&filter=duration:[1+TO+30]`;
        const simple = await axios.get(simpleUrl, { timeout: 10000 });
        results = simple.data.results || [];
      }
    }

    if (!results.length) return null;
    return mapSounds(results);
  } catch (err) {
    console.error('Freesound error:', err.message);
    return null;
  }
}

// ─── SPOTIFY ─────────────────────────────────────────────
async function getSpotifyToken() {
  const res = await axios.post('https://accounts.spotify.com/api/token', 'grant_type=client_credentials', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET).toString('base64') },
  });
  return res.data.access_token;
}

async function getTrackFeatures(trackName) {
  try {
    const token = await getSpotifyToken();
    const search = await axios.get('https://api.spotify.com/v1/search', { headers: { Authorization: `Bearer ${token}` }, params: { q: trackName, type: 'track', limit: 1 } });
    const track = search.data.tracks.items[0];
    if (!track) return null;
    const features = await axios.get(`https://api.spotify.com/v1/audio-features/${track.id}`, { headers: { Authorization: `Bearer ${token}` } });
    const keys = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    return {
      name: track.name, artist: track.artists[0].name,
      bpm: Math.round(features.data.tempo),
      key: keys[features.data.key] + ' ' + ['Minor','Major'][features.data.mode],
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
    const keys = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    return {
      name: artistName, bpm: avg('tempo'), energy: Math.round(avg('energy')),
      danceability: Math.round(avg('danceability')), valence: Math.round(avg('valence')),
      loudness: (features.reduce((s,f)=>s+f.loudness,0)/features.length).toFixed(1),
      key: keys[Math.abs(avg('key'))%12] + ' ' + ['Minor','Major'][avg('mode')>0?1:0],
    };
  } catch (err) { console.error('Artist stats error:', err.message); return null; }
}

// ─── AUDIO ANALYSIS ──────────────────────────────────────
async function analyzeAudioFile(fileUrl, filename) {
  const filePath = path.join('/tmp', filename.replace(/[^a-zA-Z0-9._-]/g, '_'));
  try {
    const response = await axios.get(fileUrl, { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }, responseType: 'arraybuffer', timeout: 30000 });
    fs.writeFileSync(filePath, response.data);
    const result = execSync(`python3 analyze.py "${filePath}"`, { timeout: 60000 }).toString().trim();
    const analysis = JSON.parse(result);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return analysis;
  } catch (err) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { error: err.message };
  }
}

// ─── BLOCK KIT HELPERS ───────────────────────────────────
const divider = () => ({ type: 'divider' });
const header = t => ({ type: 'header', text: { type: 'plain_text', text: t, emoji: true } });
const section = t => ({ type: 'section', text: { type: 'mrkdwn', text: t } });
const twoCol = (l, r) => ({ type: 'section', fields: [{ type: 'mrkdwn', text: l }, { type: 'mrkdwn', text: r }] });
const context = t => ({ type: 'context', elements: [{ type: 'mrkdwn', text: t }] });
const btn = (text, actionId, style) => {
  const b = { type: 'button', text: { type: 'plain_text', text, emoji: true }, action_id: actionId };
  if (style) b.style = style;
  return b;
};
const actions = btns => ({ type: 'actions', elements: btns });

// ─── SESSIONS ────────────────────────────────────────────
global.compareSessions = global.compareSessions || {};
const getCompareSession = id => global.compareSessions[id] || null;
const startCompareSession = id => {
  global.compareSessions[id] = { status: 'waiting_your_track', yourTrack: null, referenceTrack: null, startedAt: new Date().toISOString() };
  return global.compareSessions[id];
};
const clearCompareSession = id => { delete global.compareSessions[id]; };

global.collabSessions = global.collabSessions || {};
const getCollabSession = id => global.collabSessions[id] || null;
const startCollabSession = (channelId, trackName, userId) => {
  global.collabSessions[channelId] = { trackName, startedBy: userId, startedAt: new Date().toISOString(), ideas: [], feedback: [], decisions: [] };
  return global.collabSessions[channelId];
};
const endCollabSession = id => { const s = global.collabSessions[id]; delete global.collabSessions[id]; return s; };

// ─── WELCOME BLOCKS ───────────────────────────────────────
function getWelcomeBlocks() {
  return [
    header('🎛️ Hey! I\'m Wavmind 👋'),
    section('I\'m your AI music production agent. I help you make better music inside Slack.\n\n*What do you want to do?*'),
    divider(),
    actions([
      btn('🎵 Analyze My Music', 'menu_analyze', 'primary'),
      btn('🎹 Make Music', 'menu_create'),
    ]),
    actions([
      btn('🎚️ Get Feedback', 'menu_feedback'),
      btn('🤝 Team Session', 'menu_collab'),
    ]),
    divider(),
    context('💡 Or just type what you need · `/wavmind samples piano` · `/wavmind daw fl studio sidechain` · `/wavmind compare`'),
  ];
}

// ─── MENU BLOCKS ─────────────────────────────────────────
function getAnalyzeBlocks() {
  return [
    header('🔬 Analyze Your Music'),
    divider(),
    section('*🆚 Compare Your Track vs Reference*\nUpload your beat + a reference song → gap report with specific fix recommendations\n\n`/wavmind compare`'),
    section('*🔍 Analyze Any Song*\nGet real Spotify data + production blueprint\n\n`/wavmind reference Blinding Lights - The Weeknd`'),
    section('*🎛️ Quick Audio Scan*\nJust upload any MP3 or WAV — Wavmind scans energy, bass and brightness automatically'),
    divider(),
    actions([btn('← Back to Menu', 'menu_main')]),
  ];
}

function getCreateBlocks() {
  return [
    header('🎹 Make Music'),
    divider(),
    section('*🎵 Free Samples*\n`/wavmind samples drums` · `/wavmind samples piano` · `/wavmind samples bass`\n`/wavmind samples guitar` · `/wavmind samples synth` · `/wavmind samples strings`\n_Run the same command again for different results every time_'),
    section('*💡 Track Ideas*\n`/wavmind ideas dark trap`\n`/wavmind ideas lo-fi chill`\n`/wavmind ideas melodic drill`'),
    section('*🎹 Chord Progressions*\n`/wavmind chords F minor trap`\n`/wavmind chords C major pop`\n`/wavmind chords A minor jazz`'),
    section('*🥁 BPM & Key*\n`/wavmind bpm dark hip hop`\n`/wavmind bpm lo-fi`\n`/wavmind bpm drill`'),
    section('*🎹 DAW Help*\n`/wavmind daw fl studio sidechain 808`\n`/wavmind daw ableton warp audio`\n`/wavmind daw logic pro flex pitch`'),
    divider(),
    actions([btn('← Back to Menu', 'menu_main')]),
  ];
}

function getFeedbackBlocks() {
  return [
    header('🎚️ Get Feedback'),
    divider(),
    section('*🎚️ Mix Feedback*\n`/wavmind feedback my trap beat at 140bpm feels muddy`'),
    section('*🎛️ Deep Mix Analysis*\nUpload your audio first, then:\n`/wavmind feedback bpm:140 key:F_minor`'),
    section('*🎯 Label Evaluation*\n`/wavmind label dark trap 140bpm heavy 808s melodic piano`'),
    section('*🎤 Artist Comparison*\n`/wavmind artist Drake and Travis Scott`\n`/wavmind artist Kanye vs Tyler the Creator`'),
    divider(),
    actions([btn('← Back to Menu', 'menu_main')]),
  ];
}

function getCollabBlocks() {
  return [
    header('🤝 Team Session'),
    divider(),
    section('*Start a session:*\n`/wavmind collab Dark Trap EP`'),
    section('*During the session:*\n`/wavmind idea use heavy reverb on the snare`\n`/wavmind note the bass needs to be louder`\n`/wavmind decided going with F minor key`'),
    section('*Get a summary:*\n`/wavmind summary`'),
    section('*End session:*\n`/wavmind end`'),
    divider(),
    context('Wavmind logs everything and generates an AI summary at the end'),
    actions([btn('← Back to Menu', 'menu_main')]),
  ];
}

// ─── BUTTON HANDLERS ─────────────────────────────────────
app.action('menu_main', async ({ body, ack, client }) => {
  await ack();
  await client.chat.postMessage({ channel: body.user.id, blocks: getWelcomeBlocks() });
});

app.action('menu_analyze', async ({ body, ack, client }) => {
  await ack();
  await client.chat.postMessage({ channel: body.user.id, blocks: getAnalyzeBlocks() });
});

app.action('menu_create', async ({ body, ack, client }) => {
  await ack();
  await client.chat.postMessage({ channel: body.user.id, blocks: getCreateBlocks() });
});

app.action('menu_feedback', async ({ body, ack, client }) => {
  await ack();
  await client.chat.postMessage({ channel: body.user.id, blocks: getFeedbackBlocks() });
});

app.action('menu_collab', async ({ body, ack, client }) => {
  await ack();
  await client.chat.postMessage({ channel: body.user.id, blocks: getCollabBlocks() });
});

app.action('quick_compare', async ({ body, ack, client }) => {
  await ack();
  startCompareSession(body.user.id);
  await client.chat.postMessage({
    channel: body.user.id,
    blocks: [
      header('🆚 Comparison Started!'),
      section('*Step 1* — Upload YOUR track\n*Step 2* — Upload your REFERENCE track\n\nWavmind compares both automatically.'),
      context('Cancel: `/wavmind cancel`'),
    ],
  });
});

app.action('quick_feedback', async ({ body, ack, client }) => {
  await ack();
  await client.chat.postMessage({
    channel: body.user.id,
    blocks: [
      header('🎚️ Mix Feedback'),
      section('Describe your mix:\n\n`/wavmind feedback my trap beat at 140bpm feels muddy in the low end`'),
    ],
  });
});

// ─── APP HOME ─────────────────────────────────────────────
async function publishAppHome(client, userId) {
  const uploads = global.userUploads[userId] || [];
  const lastUpload = uploads[uploads.length - 1];
  const stats = global.weeklyStats[userId];

  await client.views.publish({
    user_id: userId,
    view: {
      type: 'home',
      blocks: [
        section('*🎛️ Wavmind*\n_Your autonomous AI music production agent_'),
        divider(),

        ...(lastUpload ? [
          header('📊 Your Last Track'),
          twoCol(`🎵 *File*\n${lastUpload.filename}`, `⚡ *Energy*\n${lastUpload.analysis.energy}%`),
          twoCol(`🔊 *Bass*\n${lastUpload.analysis.bass_ratio}%`, `🌈 *Brightness*\n${lastUpload.analysis.brightness}`),
          context(`_Scanned ${new Date(lastUpload.timestamp).toLocaleDateString()} · Reminder DM in 24hrs_`),
          actions([
            btn('🆚 Compare with Reference', 'quick_compare', 'primary'),
            btn('🎚️ Get Feedback', 'quick_feedback'),
          ]),
          divider(),
        ] : []),

        ...(stats && stats.tracks > 0 ? [
          header('📈 This Week'),
          twoCol(`🎵 *Tracks Scanned*\n${stats.tracks}`, `⚠️ *Top Issue*\n${stats.issues[0] || 'None'}`),
          divider(),
        ] : []),

        header('🎛️ What Can I Do?'),
        twoCol(
          '*🆚 Compare Tracks*\nYour mix vs reference → gap report\n\n`/wavmind compare`',
          '*🔍 Analyze a Song*\nReal Spotify data + blueprint\n\n`/wavmind reference [song]`'
        ),
        twoCol(
          '*🎵 Free Samples*\nDifferent results every time\n\n`/wavmind samples piano`\n`/wavmind samples drums`',
          '*🎹 DAW Help*\nStep-by-step tutorials\n\n`/wavmind daw fl studio [question]`'
        ),
        twoCol(
          '*🎚️ Mix Feedback*\nProfessional AI advice\n\n`/wavmind feedback [describe]`',
          '*🎯 Label Evaluation*\nA&R assessment\n\n`/wavmind label [describe]`'
        ),
        twoCol(
          '*🎤 Artist Comparison*\nSpotify DNA analysis\n\n`/wavmind artist [a] and [b]`',
          '*🤝 Team Sessions*\nCollaborate on tracks\n\n`/wavmind collab [track name]`'
        ),
        twoCol(
          '*💡 Track Ideas*\n`/wavmind ideas dark trap`',
          '*🎹 Chord Progressions*\n`/wavmind chords F minor trap`'
        ),
        divider(),

        header('🎵 Sample Library'),
        section('Search 500,000+ free sounds — *different results every search:*\n\n`/wavmind samples piano` · `/wavmind samples synth` · `/wavmind samples bass`\n`/wavmind samples guitar` · `/wavmind samples drums` · `/wavmind samples strings`\n`/wavmind samples violin` · `/wavmind samples flute` · `/wavmind samples vocal`\n`/wavmind samples ambient` · `/wavmind samples trumpet` · `/wavmind samples saxophone`\n\n_Run the same command twice — you get completely different sounds each time_'),
        divider(),

        header('🎛️ Audio Upload Workflow'),
        section('*Quick scan:*\n① Upload MP3/WAV → auto scan\n② `/wavmind feedback bpm:85 key:F_minor`\n\n*Compare with reference:*\n① `/wavmind compare`\n② Upload your track → Upload reference\n③ Gap report + AI recommendations'),
        context('💡 Key format: `C_major` · `F_minor` · `G_major` · `A_minor` · `Bb_major`'),
        divider(),

        header('🎹 DAW Help Examples'),
        section('`/wavmind daw fl studio sidechain 808`\n`/wavmind daw ableton warp audio`\n`/wavmind daw logic pro flex pitch`\n`/wavmind daw pro tools set up sessions`\n`/wavmind daw cubase chord track`'),
        context('FL Studio · Ableton · Logic Pro · Pro Tools · Cubase · Studio One · GarageBand · Reaper · Bitwig'),
        divider(),

        header('🤖 Autonomous Features'),
        section('• *24hr Reminder* — Uploads a track? Wavmind DMs you the next day\n• *Weekly Report* — Every Monday: your production summary\n• *Channel Monitor* — Spots music topics and jumps in with tips\n• *MCP Server* — Any AI agent can connect to Wavmind\'s tools'),
        divider(),

        header('⚡ Powered By'),
        twoCol('🤖 *Groq AI* — Llama 3.1', '🎵 *Spotify* — Real audio data'),
        twoCol('🔍 *Tavily* — Real-time search', '🎵 *Freesound* — 500K+ samples'),
        twoCol('🎧 *Librosa* — Audio analysis', '🔌 *MCP* — AI agent protocol'),
        divider(),
        context('🎛️ *Wavmind* — Type `/wavmind` to get started'),
      ],
    },
  });
}

app.event('app_home_opened', async ({ event, client }) => {
  try { await publishAppHome(client, event.user); } catch (err) { console.error('Home error:', err.message); }
});

// ─── CHANNEL MONITORING ───────────────────────────────────
app.message(async ({ message, say }) => {
  if (message.subtype || !message.text) return;
  const lower = message.text.toLowerCase().trim();
  if (['hi','hello','hey','start','help'].includes(lower)) {
    await say({ blocks: getWelcomeBlocks() });
    return;
  }
  const keywords = ['muddy','808','sidechain','compress','reverb','delay','mixing','mastering','plugin','vst','fl studio','ableton','logic pro','melody','chord','bass line','hi-hat','kick','snare','bpm'];
  const hasKeyword = keywords.some(kw => lower.includes(kw));
  if (hasKeyword && !lower.startsWith('/') && Math.random() < 0.33) {
    try {
      const r = await askAI(`Music producer said: "${message.text}". 2-sentence tip. End with one Wavmind command. Be natural.`);
      if (r) await say({ thread_ts: message.ts, blocks: [section(`🎛️ *Wavmind:* ${r}`), context('Type `/wavmind` for all features')] });
    } catch (err) { console.error('Monitor error:', err.message); }
  }
});

// ─── FILE UPLOAD HANDLER ─────────────────────────────────
app.event('file_shared', async ({ event, client }) => {
  try {
    const fileInfo = await client.files.info({ file: event.file_id });
    const file = fileInfo.file;
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['mp3','wav','flac','aac','m4a','ogg'].includes(ext)) return;

    const userId = event.user_id;
    const channelId = event.channel_id;
    const compareSession = userId ? getCompareSession(userId) : null;

    if (compareSession) {
      if (compareSession.status === 'waiting_your_track') {
        await client.chat.postMessage({ channel: channelId, blocks: [header('🎵 Scanning Your Track...'), section(`*File:* ${file.name}`), context('⏳ Step 1 of 2')] });
        const analysis = await analyzeAudioFile(file.url_private_download, file.name);
        if (!analysis || analysis.error) { await client.chat.postMessage({ channel: channelId, blocks: [header('❗ Scan Failed'), section('Try MP3 under 10MB.')] }); return; }
        compareSession.yourTrack = { filename: file.name, energy: analysis.energy, brightness: analysis.brightness, bass_ratio: analysis.bass_ratio, duration: analysis.duration };
        compareSession.status = 'waiting_reference';
        const mins = Math.floor(analysis.duration / 60); const secs = String(analysis.duration % 60).padStart(2, '0');
        await client.chat.postMessage({
          channel: channelId,
          blocks: [
            header('✅ Your Track Scanned — Step 1 of 2'),
            section(`*File:* ${file.name}`),
            divider(),
            twoCol(`⚡ *Energy*\n${analysis.energy}%`, `🌈 *Brightness*\n${analysis.brightness}`),
            twoCol(`🔊 *Bass*\n${analysis.bass_ratio}%`, `⏱️ *Duration*\n${mins}:${secs}`),
            divider(),
            header('🎯 Step 2 — Upload Your Reference Track'),
            section('Upload the song you want to sound like.'),
            context('Wavmind will compare both automatically'),
          ],
        });
      } else if (compareSession.status === 'waiting_reference') {
        await client.chat.postMessage({ channel: channelId, blocks: [header('🔍 Scanning Reference...'), section(`*File:* ${file.name}`), context('⏳ Generating report...')] });
        const analysis = await analyzeAudioFile(file.url_private_download, file.name);
        if (!analysis || analysis.error) { await client.chat.postMessage({ channel: channelId, blocks: [header('❗ Scan Failed'), section('Try MP3 under 10MB.')] }); return; }
        compareSession.referenceTrack = { filename: file.name, energy: analysis.energy, brightness: analysis.brightness, bass_ratio: analysis.bass_ratio, duration: analysis.duration };
        const yours = compareSession.yourTrack; const ref = compareSession.referenceTrack;
        const energyDiff = ref.energy - yours.energy; const bassDiff = ref.bass_ratio - yours.bass_ratio;
        const bMap = { 'Dark (heavy low end)': 1, 'Balanced': 2, 'Bright (strong high end)': 3 };
        const brightDiff = (bMap[ref.brightness] || 2) - (bMap[yours.brightness] || 2);
        const yourMins = Math.floor(yours.duration / 60); const yourSecs = String(yours.duration % 60).padStart(2, '0');
        const refMins = Math.floor(ref.duration / 60); const refSecs = String(ref.duration % 60).padStart(2, '0');
        const aiAnalysis = await askAI(`Professional mixing engineer:
YOUR TRACK "${yours.filename}": Energy ${yours.energy}%, Brightness ${yours.brightness}, Bass ${yours.bass_ratio}%
REFERENCE "${ref.filename}": Energy ${ref.energy}%, Brightness ${ref.brightness}, Bass ${ref.bass_ratio}%
Energy gap: ${Math.abs(energyDiff)}% ${energyDiff > 0 ? '(ref higher)' : '(yours higher)'}
Bass gap: ${Math.abs(bassDiff)}% ${bassDiff > 0 ? '(ref heavier)' : '(yours heavier)'}
Brightness: ${brightDiff > 0 ? 'Ref brighter' : brightDiff < 0 ? 'Yours brighter' : 'Matched'}
Specific EQ, compression, bass advice. Top 3 changes. Real plugin names.`);
        clearCompareSession(userId);
        await client.chat.postMessage({
          channel: channelId,
          blocks: [
            header('🆚 Mix Comparison Report'),
            divider(),
            twoCol(`🎵 *Your Track*\n${yours.filename}`, `🎯 *Reference*\n${ref.filename}`),
            divider(),
            section('📊 *Side-by-Side Analysis*'),
            twoCol(`⚡ *Your Energy*\n${yours.energy}%`, `⚡ *Ref Energy*\n${ref.energy}%  ${Math.abs(energyDiff) <= 5 ? '✅ Match' : energyDiff > 0 ? '⚠️ Ref higher' : '✅ Yours higher'}`),
            twoCol(`🔊 *Your Bass*\n${yours.bass_ratio}%`, `🔊 *Ref Bass*\n${ref.bass_ratio}%  ${Math.abs(bassDiff) <= 5 ? '✅ Match' : bassDiff > 0 ? '⚠️ Ref heavier' : '✅ Yours heavier'}`),
            twoCol(`🌈 *Your Brightness*\n${yours.brightness}`, `🌈 *Ref Brightness*\n${ref.brightness}  ${brightDiff === 0 ? '✅ Match' : '⚠️ Gap'}`),
            twoCol(`⏱️ *Your Duration*\n${yourMins}:${yourSecs}`, `⏱️ *Ref Duration*\n${refMins}:${refSecs}`),
            divider(),
            header('🤖 How to Close the Gap'),
            section(aiAnalysis || 'Could not generate analysis.'),
            divider(),
            section('*Next Steps:*\n• Apply the recommended changes\n• Re-export your track\n• Type `/wavmind compare` again to check progress'),
            context('Type `/wavmind compare` to start over'),
          ],
        });
      }
      return;
    }

    // Normal upload
    await client.chat.postMessage({ channel: channelId, blocks: [header('🎵 Scanning Your Track...'), section(`*File:* ${file.name}`), context('⏳ Analyzing...')] });
    const analysis = await analyzeAudioFile(file.url_private_download, file.name);
    if (!analysis || analysis.error) { await client.chat.postMessage({ channel: channelId, blocks: [header('❗ Scan Failed'), section('Try MP3 under 10MB.')] }); return; }

    if (userId) trackUpload(userId, file.name, analysis);
    global.pendingAnalysis = global.pendingAnalysis || {};
    global.pendingAnalysis[channelId] = { filename: file.name, energy: analysis.energy, brightness: analysis.brightness, bass_ratio: analysis.bass_ratio, duration: analysis.duration };

    const mins = Math.floor(analysis.duration / 60); const secs = String(analysis.duration % 60).padStart(2, '0');
    const issues = [];
    if (analysis.energy < 50) issues.push('⚠️ Low energy — mix may lack punch');
    if (analysis.bass_ratio > 65) issues.push('⚠️ Heavy bass — may sound muddy on small speakers');
    if (analysis.bass_ratio < 20) issues.push('⚠️ Thin bass — needs more low end');

    await client.chat.postMessage({
      channel: channelId,
      blocks: [
        header('🎛️ Scan Complete'),
        section(`*File:* ${file.name}`),
        divider(),
        twoCol(`⚡ *Energy*\n${analysis.energy}%`, `🌈 *Brightness*\n${analysis.brightness}`),
        twoCol(`🔊 *Bass*\n${analysis.bass_ratio}%`, `⏱️ *Duration*\n${mins}:${secs}`),
        ...(issues.length > 0 ? [divider(), section(`*Quick Insights:*\n${issues.join('\n')}`)] : []),
        divider(),
        section('*What do you want to do next?*'),
        actions([
          btn('🆚 Compare with Reference', 'quick_compare', 'primary'),
          btn('🎚️ Get Mix Feedback', 'quick_feedback'),
        ]),
        context('🤖 Wavmind will DM you tomorrow with a follow-up reminder'),
      ],
    });

    if (userId) { try { await publishAppHome(client, userId); } catch (e) {} }
  } catch (err) { console.error('File error:', err.message); }
});

// ─── SCHEDULER ────────────────────────────────────────────
function startScheduler(client) {
  const checkReminders = async () => {
    try {
      const now = new Date();
      let changed = false;
      for (const userId of Object.keys(global.pendingReminders)) {
        for (const reminder of global.pendingReminders[userId]) {
          if (reminder.sent || new Date(reminder.remindAt) > now) continue;
          reminder.sent = true; changed = true;
          const issues = [];
          if (reminder.analysis.energy < 50) issues.push('☐ Low energy — needs more punch');
          if (reminder.analysis.bass_ratio > 65) issues.push('☐ Heavy bass — check on small speakers');
          if (reminder.analysis.bass_ratio < 20) issues.push('☐ Thin bass — add more low end');
          console.log(`📬 Reminder → ${userId} for "${reminder.filename}"`);
          await client.chat.postMessage({
            channel: userId,
            blocks: [
              header('🎛️ Wavmind Check-in'),
              section(`Hey! You uploaded *"${reminder.filename}"* yesterday.\n\nHave you fixed these issues?`),
              divider(),
              ...(issues.length > 0 ? [section(`*Pending:*\n${issues.join('\n')}`)] : [section('✅ Your track looked clean. Ready to release?')]),
              divider(),
              actions([
                btn('🆚 Compare with Reference', 'quick_compare', 'primary'),
                btn('🎚️ Get Fresh Feedback', 'quick_feedback'),
              ]),
              context('🤖 Autonomous check-in from Wavmind'),
            ],
          });
          try { await publishAppHome(client, userId); } catch (e) {}
        }
      }
      if (changed) saveReminders(global.pendingReminders);
    } catch (err) { console.error('Reminder check error:', err.message); }
  };

  checkReminders();
  setInterval(checkReminders, 5 * 60 * 1000);
  console.log('⏰ Reminder checker running every 5 minutes');

  const sendDigest = async () => {
    try {
      for (const userId of Object.keys(global.weeklyStats)) {
        const stats = global.weeklyStats[userId];
        if (!stats || stats.tracks === 0) continue;
        const topIssue = stats.issues.sort((a,b) => stats.issues.filter(i=>i===b).length - stats.issues.filter(i=>i===a).length)[0] || 'None';
        const tip = await askAI(`Producer analyzed ${stats.tracks} tracks. Issue: ${topIssue}. One specific tip. Under 50 words.`);
        await client.chat.postMessage({
          channel: userId,
          blocks: [
            header('📊 Your Weekly Report'),
            section(`*Week of ${new Date().toLocaleDateString()}*`),
            divider(),
            twoCol(`🎵 *Tracks Scanned*\n${stats.tracks}`, `⚠️ *Top Issue*\n${topIssue}`),
            divider(),
            section(`*🤖 This week's tip:*\n${tip || 'Keep producing!'}`),
            divider(),
            section('*Try this week:*\n`/wavmind compare` — Check your mix\n`/wavmind samples` — Find new sounds\n`/wavmind daw [daw] [question]` — Learn something new'),
            context('📊 Automated weekly report · Every Monday · Wavmind'),
          ],
        });
        global.weeklyStats[userId] = { tracks: 0, issues: [] };
        saveStats(global.weeklyStats);
      }
    } catch (err) { console.error('Digest error:', err.message); }
  };

  const now = new Date();
  const nextMonday = new Date();
  nextMonday.setDate(now.getDate() + ((1 + 7 - now.getDay()) % 7 || 7));
  nextMonday.setHours(9, 0, 0, 0);
  setTimeout(() => { sendDigest(); setInterval(sendDigest, 7 * 24 * 60 * 60 * 1000); }, nextMonday - now);
  console.log(`📅 Weekly digest scheduled for ${nextMonday.toLocaleString()}`);
}

// ─── MCP SERVER ───────────────────────────────────────────
function startMCPServer() {
  const mcpTools = [
    { name: 'search_samples', description: 'Search 500K+ free Creative Commons samples from Freesound — returns different results every call' },
    { name: 'get_track_features', description: 'Get real Spotify audio features for any track' },
    { name: 'analyze_mix', description: 'Get AI mixing feedback' },
    { name: 'get_daw_help', description: 'Get DAW tutorials via Tavily + AI' },
    { name: 'compare_artists', description: 'Compare two artists via Spotify data' },
    { name: 'get_track_ideas', description: 'Generate track concepts for any genre' },
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
        if (req.url === '/health') { res.writeHead(200); res.end(JSON.stringify({ status: 'ok', service: 'Wavmind AI Producer Agent', version: '1.0.0', tools: mcpTools.map(t => t.name) })); return; }
        if (req.url === '/mcp') { res.writeHead(200); res.end(JSON.stringify({ name: 'wavmind', version: '1.0.0', description: 'AI tools for music producers', tools: mcpTools })); return; }
        if (req.url === '/mcp/tools') { res.writeHead(200); res.end(JSON.stringify({ tools: mcpTools })); return; }
        if (req.method === 'POST' && req.url === '/mcp/execute') {
          const { tool, arguments: args } = JSON.parse(body);
          let result;
          switch (tool) {
            case 'search_samples': result = await searchFreesound(args.query); break;
            case 'get_track_features': result = await getTrackFeatures(args.track_name); break;
            case 'analyze_mix': result = await askAI(`Mix feedback: ${args.description}. BPM: ${args.bpm||'?'}, Key: ${args.key||'?'}.`); break;
            case 'get_daw_help': { const [t,a] = await Promise.all([tavilySearch(`${args.daw} ${args.question}`), askAI(`${args.daw} tutorial: "${args.question}"`)]); result = { ai_answer: a, web_answer: t?.answer, sources: t?.results }; break; }
            case 'compare_artists': { const [s1,s2] = await Promise.all([getArtistStats(args.artist1), getArtistStats(args.artist2)]); result = { artist1: s1, artist2: s2 }; break; }
            case 'get_track_ideas': result = await askAI(`5 track ideas for "${args.genre}".`); break;
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

// ─── SLASH COMMANDS ───────────────────────────────────────
app.command('/wavmind', async ({ command, ack, respond, client }) => {
  await ack();
  const input = command.text.trim();
  const lower = input.toLowerCase();
  const userId = command.user_id;

  if (!input || lower === 'help' || lower === 'menu') {
    await respond({ response_type: 'ephemeral', blocks: getWelcomeBlocks() });
    return;
  }

  // ─── COMPARE ─────────────────────────────────────────
  if (lower === 'compare' || lower === 'compare start') {
    if (getCompareSession(userId)) {
      const s = getCompareSession(userId);
      await respond({ blocks: [header('⚠️ Already Running'), section(`Status: ${s.status === 'waiting_your_track' ? 'Upload your track' : 'Upload reference track'}\n\nCancel: \`/wavmind cancel\``)] });
      return;
    }
    startCompareSession(userId);
    await respond({
      response_type: 'in_channel',
      blocks: [
        header('🆚 Mix Comparison Started'),
        section(`*<@${userId}>* follow these steps:`),
        divider(),
        section('*Step 1* — Upload YOUR track\n_The beat you\'re working on_'),
        section('*Step 2* — Upload your REFERENCE track\n_The song you want to sound like_'),
        section('*Step 3* — Wavmind automatically:\n• Compares energy, bass, brightness side by side\n• Shows ✅ Match or ⚠️ Gap for each element\n• Gives specific AI advice to close each gap'),
        divider(),
        context('Upload your track now · Cancel: `/wavmind cancel`'),
      ],
    });
    return;
  }

  // ─── CANCEL ──────────────────────────────────────────
  if (lower === 'cancel') {
    clearCompareSession(userId);
    await respond({ blocks: [header('🗑️ Cancelled'), section('Start again: `/wavmind compare`')] });
    return;
  }

  // ─── SAMPLES ─────────────────────────────────────────
  if (lower.startsWith('samples') || lower.startsWith('sample')) {
    const query = input.replace(/^samples?\s*/i, '').trim();
    if (!query) {
      await respond({
        blocks: [
          header('🎵 Free Sample Search'),
          section('Search 500,000+ Creative Commons sounds.\n*Run the same command twice for completely different results!*\n\n*Instruments:*\n`/wavmind samples piano` · `/wavmind samples synth` · `/wavmind samples bass`\n`/wavmind samples guitar` · `/wavmind samples drums` · `/wavmind samples strings`\n`/wavmind samples violin` · `/wavmind samples flute` · `/wavmind samples trumpet`\n`/wavmind samples saxophone` · `/wavmind samples harp` · `/wavmind samples vocal`\n\n*Styles:*\n`/wavmind samples trap drums` · `/wavmind samples lo-fi piano`\n`/wavmind samples jazz guitar` · `/wavmind samples ambient synth`\n`/wavmind samples cinematic strings` · `/wavmind samples 808 bass`'),
          context('All Creative Commons — free to use in your music'),
        ],
      });
      return;
    }

    await respond({
      blocks: [
        header('🎵 Searching Freesound...'),
        section(`*"${query}"*`),
        context('⏳ Finding fresh sounds — different results every search'),
      ],
    });

    // Pass userId so page tracker works per user
    const sounds = await searchFreesound(query, userId);

    if (!sounds || !sounds.length) {
      // Try simplified query
      const simple = query.split(' ')[0];
      const retry = simple !== query ? await searchFreesound(simple, userId) : null;
      if (retry?.length) {
        const blocks = [
          header(`🎵 Results for "${simple}"`),
          section(`_No exact results for "${query}" — showing results for "${simple}"_\n_Run again for different results_`),
          divider(),
        ];
        retry.slice(0, 8).forEach((s, i) => {
          blocks.push(section(
            `*${i+1}. ${s.name}*\n` +
            `⏱️ *${s.duration}s* · ⭐ *${s.rating}/5* · 📥 *${s.downloads.toLocaleString()}*\n` +
            `📄 ${s.license} · 👤 ${s.username}\n` +
            `🏷️ ${s.tags}\n\n` +
            `${s.preview ? `🔊 *<${s.preview}|▶ Listen>*     ` : ''}` +
            `🔗 *<${s.url}|📥 Download>*`
          ));
          if (i < retry.slice(0,8).length - 1) blocks.push(divider());
        });
        blocks.push(divider(), context(`Run \`/wavmind samples ${simple}\` again for different sounds · Powered by Freesound.org`));
        await respond({ blocks });
      } else {
        await respond({
          blocks: [
            header('❗ No Results Found'),
            section(`No sounds for *"${query}"*.\n\n*Try:*\n\`/wavmind samples piano\`\n\`/wavmind samples drums\`\n\`/wavmind samples bass\`\n\`/wavmind samples guitar\`\n\`/wavmind samples synth\``),
            section(`🔗 *<https://freesound.org/search/?q=${encodeURIComponent(query)}|Browse Freesound directly>*`),
          ],
        });
      }
      return;
    }

    // AI production tip for these sounds
    const aiTip = await askAI(
      `Music producer is looking for "${query}" samples and found these: ${sounds.slice(0,3).map(s=>s.name).join(', ')}. ` +
      `Give 2-3 specific production tips for using ${query} samples in music. Under 60 words. Bullet points.`
    );

    const blocks = [
      header(`🎵 Free Samples: "${query}"`),
      section(`Found *${sounds.length} sounds* — all free to use · _Different results every search_`),
      context('🔊 Click Listen to preview · 📥 Click Download to get the full file'),
      divider(),
    ];

    sounds.forEach((s, i) => {
      blocks.push(
        section(
          `*${i+1}. ${s.name}*\n` +
          `⏱️ *Duration:* ${s.duration}s · ` +
          `⭐ *Rating:* ${s.rating}/5 · ` +
          `📥 *Downloads:* ${s.downloads.toLocaleString()}\n` +
          `📄 *License:* ${s.license} · ` +
          `👤 *By:* ${s.username}\n` +
          `🏷️ *Tags:* ${s.tags}\n\n` +
          `${s.preview ? `🔊 *<${s.preview}|▶ Listen to Preview>*     ` : ''}` +
          `🔗 *<${s.url}|📥 View & Download on Freesound>*`
        )
      );
      if (i < sounds.length - 1) blocks.push(divider());
    });

    if (aiTip) {
      blocks.push(divider(), header(`💡 Tips for Using ${query.charAt(0).toUpperCase() + query.slice(1)} Samples`), section(aiTip));
    }

    blocks.push(
      divider(),
      section(`🔗 *<https://freesound.org/search/?q=${encodeURIComponent(query)}|Browse even more "${query}" sounds on Freesound>*`),
      context(`🎵 Creative Commons · Freesound.org · Run \`/wavmind samples ${query}\` again for completely different sounds`)
    );

    await respond({ blocks });
    return;
  }

  // ─── REFERENCE ───────────────────────────────────────
  if (lower.startsWith('reference')) {
    const q = input.slice(9).trim();
    if (!q) {
      await respond({
        blocks: [
          header('🔍 Reference Track Analysis'),
          section('Get real Spotify data + production blueprint for any song.\n\n*Examples:*\n`/wavmind reference Blinding Lights - The Weeknd`\n`/wavmind reference God\'s Plan - Drake`\n`/wavmind reference SICKO MODE - Travis Scott`'),
        ],
      });
      return;
    }
    await respond({ blocks: [header('🔍 Looking Up on Spotify...'), section(`*${q}*`), context('⏳')] });
    const f = await getTrackFeatures(q);
    if (f) {
      const r = await askAI(`Advice on achieving sound of ${f.name} by ${f.artist}: BPM ${f.bpm}, Key ${f.key}, Energy ${f.energy}%, Loudness ${f.loudness}dB. Specific techniques and real plugin names.`);
      await respond({
        blocks: [
          header('🎵 Reference Analysis'),
          section(`*${f.name}* by *${f.artist}*`),
          divider(),
          section('📊 *Real Spotify Data*'),
          twoCol(`🥁 *BPM*\n${f.bpm}`, `🎵 *Key*\n${f.key}`),
          twoCol(`⚡ *Energy*\n${f.energy}%`, `💃 *Danceability*\n${f.danceability}%`),
          twoCol(`🔊 *Loudness*\n${f.loudness} dB`, `😊 *Valence*\n${f.valence}%`),
          divider(),
          section('🎛️ *How to achieve this sound:*'),
          section(r || 'Error'),
          divider(),
          context('Type `/wavmind compare` to compare your track against this reference'),
        ],
      });
    } else {
      const r = await askAI(`Blueprint for "${q}". Tempo, key, drums, bass, melody, mix approach.`);
      await respond({ blocks: [header('🎵 Reference Analysis'), section(`*${q}*`), divider(), section(r || 'Error')] });
    }
    return;
  }

  // ─── FEEDBACK ────────────────────────────────────────
  if (lower.startsWith('feedback')) {
    const rest = input.slice(8).trim();
    const bpmM = rest.match(/bpm[:\s]+(\d+)/i);
    const keyM = rest.match(/key[:\s]+([\w#b_]+)/i);
    if (bpmM && keyM) {
      const bpm = parseInt(bpmM[1]); const key = keyM[1].replace(/_/g,' ');
      const stored = global.pendingAnalysis?.[command.channel_id];
      await respond({ blocks: [header('🎚️ Generating Deep Mix Feedback...'), twoCol(`🥁 *BPM*\n${bpm}`, `🎵 *Key*\n${key}`), context('⏳')] });
      const ctx = stored ? `Energy: ${stored.energy}%, Brightness: ${stored.brightness}, Bass: ${stored.bass_ratio}%` : '';
      const r = await askAI(`Professional mix feedback: BPM ${bpm}, Key ${key}. ${ctx}. EQ, compression, arrangement. Real plugin names.`);
      if (global.pendingAnalysis?.[command.channel_id]) delete global.pendingAnalysis[command.channel_id];
      await respond({
        blocks: [
          header('🎛️ Deep Mix Feedback'),
          twoCol(`🥁 *BPM*\n${bpm}`, `🎵 *Key*\n${key}`),
          stored ? twoCol(`⚡ *Energy*\n${stored.energy}%`, `🔊 *Bass*\n${stored.bass_ratio}%`) : divider(),
          divider(), section(r || 'Error'),
          context('Type `/wavmind compare` to compare your mix with a reference'),
        ],
      });
      return;
    }
    if (!rest) {
      await respond({ blocks: [header('🎚️ Mix Feedback'), section('Describe your mix:\n\n`/wavmind feedback my trap beat at 140bpm feels muddy in the low end`\n\n*After uploading audio:*\n`/wavmind feedback bpm:140 key:F_minor`')] });
      return;
    }
    await respond({ blocks: [header('🎚️ Analyzing Your Mix...'), section(`_"${rest}"_`), context('⏳')] });
    const r = await askAI(`Professional mixing feedback for: "${rest}". EQ, compression, stereo width, frequency balance. Clear sections with emojis.`);
    await respond({
      blocks: [
        header('🎚️ Mix Feedback'), section(`_${rest}_`), divider(), section(r || 'Error'), divider(),
        context('Upload MP3/WAV then `/wavmind feedback bpm:140 key:F_minor` for deeper analysis'),
      ],
    });
    return;
  }

  // ─── LABEL (A&R) ─────────────────────────────────────
  if (lower.startsWith('label')) {
    const desc = input.slice(5).trim();
    if (!desc) {
      await respond({ blocks: [header('🎯 Label Evaluation'), section('`/wavmind label dark trap 140bpm heavy 808s melodic piano`')] });
      return;
    }
    await respond({ blocks: [header('🎯 A&R Evaluation...'), section(`_"${desc}"_`), context('⏳')] });
    const r = await askAI(`Senior A&R executive evaluation: "${desc}". Commercial Potential (1-10), Playlist Potential, Target Audience, Strengths, Weaknesses, Verdict (pass/consider/strong interest). Be honest.`);
    await respond({ blocks: [header('🎯 Label Evaluation'), section(`_${desc}_`), divider(), section(r || 'Error'), context('`/wavmind release [description]` for release readiness check')] });
    return;
  }

  // ─── ARTIST ──────────────────────────────────────────
  if (lower.startsWith('artist')) {
    const artists = input.slice(6).trim();
    if (!artists) {
      await respond({ blocks: [header('🎤 Artist Comparison'), section('`/wavmind artist Drake and Travis Scott`\n`/wavmind artist Kanye vs Tyler the Creator`')] });
      return;
    }
    await respond({ blocks: [header('🔍 Comparing Artists...'), context('⏳ Fetching Spotify data')] });
    let a1, a2;
    if (artists.toLowerCase().includes(' and ')) { [a1,a2] = artists.split(/\s+and\s+/i).map(s=>s.trim()); }
    else if (artists.toLowerCase().includes(' vs ')) { [a1,a2] = artists.split(/\s+vs\s+/i).map(s=>s.trim()); }
    else { const w=artists.split(' '); const m=Math.ceil(w.length/2); a1=w.slice(0,m).join(' '); a2=w.slice(m).join(' '); }
    const [s1,s2] = await Promise.all([getArtistStats(a1), getArtistStats(a2)]);
    if (!s1||!s2) { await respond({ blocks: [header('❗ Not Found'), section('`/wavmind artist Drake and Travis Scott`')] }); return; }
    const ai = await askAI(`Compare: ${s1.name} (BPM ${s1.bpm}, Energy ${s1.energy}%, Key ${s1.key}) vs ${s2.name} (BPM ${s2.bpm}, Energy ${s2.energy}%, Key ${s2.key}). Key production differences, how to blend.`);
    await respond({
      blocks: [
        header('🎤 Artist Comparison'),
        section(`*${s1.name}* vs *${s2.name}*`),
        divider(),
        { type: 'section', fields: [{ type: 'mrkdwn', text: `*${s1.name}*` }, { type: 'mrkdwn', text: `*${s2.name}*` }] },
        { type: 'section', fields: [{ type: 'mrkdwn', text: `🥁 BPM: *${s1.bpm}*` }, { type: 'mrkdwn', text: `🥁 BPM: *${s2.bpm}*` }] },
        { type: 'section', fields: [{ type: 'mrkdwn', text: `⚡ Energy: *${s1.energy}%*` }, { type: 'mrkdwn', text: `⚡ Energy: *${s2.energy}%*` }] },
        { type: 'section', fields: [{ type: 'mrkdwn', text: `💃 Dance: *${s1.danceability}%*` }, { type: 'mrkdwn', text: `💃 Dance: *${s2.danceability}%*` }] },
        { type: 'section', fields: [{ type: 'mrkdwn', text: `🔊 Loud: *${s1.loudness}dB*` }, { type: 'mrkdwn', text: `🔊 Loud: *${s2.loudness}dB*` }] },
        { type: 'section', fields: [{ type: 'mrkdwn', text: `🎵 Key: *${s1.key}*` }, { type: 'mrkdwn', text: `🎵 Key: *${s2.key}*` }] },
        divider(),
        section(ai || 'Error'),
        context('`/wavmind reference [song]` to analyze a specific track'),
      ],
    });
    return;
  }

  // ─── DAW ─────────────────────────────────────────────
  if (lower.startsWith('daw')) {
    const dawInput = input.slice(3).trim();
    if (!dawInput) {
      await respond({
        blocks: [
          header('🎹 DAW Help'),
          section('`/wavmind daw [daw name] [question]`\n\n*Examples:*\n`/wavmind daw fl studio sidechain 808`\n`/wavmind daw ableton warp audio`\n`/wavmind daw logic pro flex pitch`\n`/wavmind daw pro tools set up sessions`\n`/wavmind daw cubase chord track`'),
          context('FL Studio · Ableton · Logic Pro · Pro Tools · Cubase · Studio One · GarageBand · Reaper · Bitwig'),
        ],
      });
      return;
    }
    const dawList = [
      { name: 'FL Studio', keywords: ['fl studio','fl','fruity loops'] },
      { name: 'Ableton Live', keywords: ['ableton','ableton live','live'] },
      { name: 'Logic Pro', keywords: ['logic','logic pro','logic pro x'] },
      { name: 'Pro Tools', keywords: ['pro tools','protools'] },
      { name: 'Cubase', keywords: ['cubase'] },
      { name: 'Studio One', keywords: ['studio one','studio 1'] },
      { name: 'GarageBand', keywords: ['garageband','garage band'] },
      { name: 'Reason', keywords: ['reason'] },
      { name: 'Bitwig', keywords: ['bitwig'] },
      { name: 'Reaper', keywords: ['reaper'] },
    ];
    let detectedDAW = null; let question = dawInput;
    for (const daw of dawList) {
      for (const kw of daw.keywords) {
        if (dawInput.toLowerCase().startsWith(kw)) { detectedDAW = daw.name; question = dawInput.slice(kw.length).trim(); break; }
      }
      if (detectedDAW) break;
    }
    if (!detectedDAW) { await respond({ blocks: [header('❗ DAW Not Recognized'), section('Example: `/wavmind daw fl studio sidechain 808`'), context('FL Studio · Ableton · Logic Pro · Pro Tools · Cubase · Studio One')] }); return; }
    await respond({ blocks: [header(`🎹 ${detectedDAW} Help`), section(`*Question:* ${question}`), context('⏳ Searching + generating answer...')] });
    const [tav, ai] = await Promise.all([
      tavilySearch(`${detectedDAW} ${question} tutorial step by step`),
      askAI(`Expert ${detectedDAW} instructor. Answer: "${question}". Numbered steps. Bold key terms.`),
    ]);
    const blocks = [header(`🎹 ${detectedDAW}: ${question}`), divider(), section('🤖 *AI Answer:*'), section(ai || 'Error')];
    if (tav?.answer) blocks.push(divider(), section('🌐 *From the Web:*'), section(tav.answer));
    if (tav?.results?.length) blocks.push(divider(), section('📚 *Resources:*'), section(tav.results.slice(0,4).map(r=>`• <${r.url}|${r.title}>`).join('\n')));
    blocks.push(context(`🎹 ${detectedDAW} · Tavily + Groq AI`));
    await respond({ blocks });
    return;
  }

  // ─── COLLAB ──────────────────────────────────────────
  if (lower.startsWith('collab')) {
    const trackName = input.slice(6).trim().replace(/['"]/g,'') || 'Untitled';
    if (getCollabSession(command.channel_id)) { await respond({ blocks: [header('⚠️ Session Active'), section('Type `/wavmind end` to finish first')] }); return; }
    startCollabSession(command.channel_id, trackName, userId);
    await respond({
      response_type: 'in_channel',
      blocks: [
        header('🤝 Collab Session Started'),
        section(`*Track:* "${trackName}"\n*By:* <@${userId}>`),
        divider(),
        section('*Log your work:*\n`/wavmind idea [idea]` — Log an idea\n`/wavmind note [feedback]` — Log feedback\n`/wavmind decided [decision]` — Log a decision'),
        section('`/wavmind summary` — Get AI summary\n`/wavmind end` — End session'),
        context(`Session active for "${trackName}"`),
      ],
    });
    return;
  }

  // ─── COLLAB ACTIONS ──────────────────────────────────
  if (lower.startsWith('idea ')) {
    const t = input.slice(5).trim(); const s = getCollabSession(command.channel_id);
    if (!s) { await respond({ blocks: [header('❗ No Session'), section('`/wavmind collab [track name]`')] }); return; }
    s.ideas.push({ text: t, user: userId, time: new Date().toISOString() });
    await respond({ response_type: 'in_channel', blocks: [header('💡 Idea Logged'), section(`*"${t}"*\n— <@${userId}>`), context(`${s.ideas.length} ideas for "${s.trackName}"`)] });
    return;
  }

  if (lower.startsWith('note ')) {
    const t = input.slice(5).trim(); const s = getCollabSession(command.channel_id);
    if (!s) { await respond({ blocks: [header('❗ No Session'), section('`/wavmind collab [track name]`')] }); return; }
    s.feedback.push({ text: t, user: userId, time: new Date().toISOString() });
    await respond({ response_type: 'in_channel', blocks: [header('📝 Note Logged'), section(`*"${t}"*\n— <@${userId}>`), context(`${s.feedback.length} notes for "${s.trackName}"`)] });
    return;
  }

  if (lower.startsWith('decided ')) {
    const t = input.slice(8).trim(); const s = getCollabSession(command.channel_id);
    if (!s) { await respond({ blocks: [header('❗ No Session'), section('`/wavmind collab [track name]`')] }); return; }
    s.decisions.push({ text: t, user: userId, time: new Date().toISOString() });
    await respond({ response_type: 'in_channel', blocks: [header('✅ Decision Logged'), section(`*"${t}"*\n— <@${userId}>`), context(`${s.decisions.length} decisions for "${s.trackName}"`)] });
    return;
  }

  if (lower === 'summary') {
    const s = getCollabSession(command.channel_id);
    if (!s) { await respond({ blocks: [header('❗ No Session'), section('`/wavmind collab [track name]`')] }); return; }
    await respond({ blocks: [header('📋 Generating...'), context('⏳')] });
    const r = await askAI(`Summarize collab for "${s.trackName}": IDEAS: ${s.ideas.map(i=>i.text).join(', ')||'None'} NOTES: ${s.feedback.map(f=>f.text).join(', ')||'None'} DECISIONS: ${s.decisions.map(d=>d.text).join(', ')||'None'}. Overview, creative direction, next steps.`);
    await respond({ response_type: 'in_channel', blocks: [header('📋 Session Summary'), section(`*"${s.trackName}"*`), divider(), twoCol(`💡 ${s.ideas.length} ideas`,`📝 ${s.feedback.length} notes`), twoCol(`✅ ${s.decisions.length} decisions`,`⏱️ ${new Date(s.startedAt).toLocaleTimeString()}`), divider(), section(r||'Error'), context('`/wavmind end` to finish')] });
    return;
  }

  if (lower === 'end') {
    const s = getCollabSession(command.channel_id);
    if (!s) { await respond({ blocks: [header('❗ No Active Session')] }); return; }
    const r = await askAI(`Final report for "${s.trackName}": IDEAS: ${s.ideas.map(i=>i.text).join(', ')||'None'} NOTES: ${s.feedback.map(f=>f.text).join(', ')||'None'} DECISIONS: ${s.decisions.map(d=>d.text).join(', ')||'None'}. Overview, decisions, action items.`);
    endCollabSession(command.channel_id);
    await respond({ response_type: 'in_channel', blocks: [header('🏁 Session Complete'), section(`*"${s.trackName}"*`), divider(), section(r||'Error'), context('`/wavmind collab [track name]` for new session')] });
    return;
  }

  // ─── PRODUCTION TOOLS ────────────────────────────────
  if (lower.startsWith('ideas')) {
    const genre = input.slice(5).trim() || 'general';
    const r = await askAI(`5 creative track ideas for "${genre}". Format: 🎵 *Title* — concept.`);
    await respond({ blocks: [header('🎵 Track Ideas'), section(`*Genre:* ${genre}`), divider(), section(r||'Error')] });
    return;
  }

  if (lower.startsWith('bpm')) {
    const mood = input.slice(3).trim() || 'general';
    const r = await askAI(`For "${mood}": ideal BPM range, best keys, chord progressions, song structure. Specific numbers.`);
    await respond({ blocks: [header('🥁 BPM & Key'), section(`*Genre:* ${mood}`), divider(), section(r||'Error')] });
    return;
  }

  if (lower.startsWith('chords')) {
    const q = input.slice(6).trim() || 'C minor trap';
    const r = await askAI(`3 chord progressions for "${q}". Each: chords, Roman numerals, feel, melody note.`);
    await respond({ blocks: [header('🎹 Chord Progressions'), section(`*${q}*`), divider(), section(r||'Error')] });
    return;
  }

  if (lower.startsWith('tips')) {
    const topic = input.slice(4).trim() || 'music production';
    const r = await askAI(`5 professional tips about "${topic}". Real techniques and plugin names.`);
    await respond({ blocks: [header('💡 Production Tips'), section(`*${topic}*`), divider(), section(r||'Error')] });
    return;
  }

  if (lower.startsWith('release')) {
    const desc = input.slice(7).trim();
    if (!desc) { await respond({ blocks: [header('❗ Missing'), section('`/wavmind release Trap beat 140bpm mixed`')] }); return; }
    const r = await askAI(`Release readiness for: "${desc}". Mix Quality, Loudness LUFS, Metadata, Distribution, Strategy, Score X/10. Checklist ✅ or ⚠️.`);
    await respond({ blocks: [header('✅ Release Readiness'), section(`_${desc}_`), divider(), section(r||'Error')] });
    return;
  }

  if (lower === 'mcp') {
    const base = `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'your-railway-url.railway.app'}`;
    await respond({
      blocks: [
        header('🔌 MCP Server'),
        section('Wavmind exposes all tools via MCP.'),
        divider(),
        section(`*Endpoints:*\n\`GET ${base}/health\`\n\`GET ${base}/mcp/tools\`\n\`POST ${base}/mcp/execute\``),
        context('Compatible with Claude, GPT and any MCP client'),
      ],
    });
    return;
  }

  // ─── GENERAL ─────────────────────────────────────────
  await respond({ blocks: [header('🤔 On it...'), context('⏳')] });
  const response = await askAI(`You are Wavmind, expert AI for music producers. Answer: "${input}"`);
  await respond({ blocks: [header('🎛️ Wavmind'), section(response||'Error'), context('Type `/wavmind` to see what I can do')] });
});

// ─── APP MENTION ──────────────────────────────────────────
app.event('app_mention', async ({ event, say }) => {
  const input = event.text.replace(/<@[^>]+>/g, '').trim();
  if (!input) { await say({ blocks: getWelcomeBlocks() }); return; }
  const r = await askAI(`You are Wavmind, expert AI for music producers. Answer: "${input}"`);
  await say({ blocks: [section(`<@${event.user}>`), section(r||'Error'), context('Type `/wavmind` for all features')] });
});

// ─── START ────────────────────────────────────────────────
(async () => {
  await app.start();
  console.log('🎛️ Wavmind Agent is running!');
  startMCPServer();
  startScheduler(app.client);
})();
