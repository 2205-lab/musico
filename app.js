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

// ─── USER TRACKING FOR AUTOMATION ────────────────────────
global.userUploads = global.userUploads || {};
global.userActivity = global.userActivity || {};
global.weeklyStats = global.weeklyStats || {};

function trackUpload(userId, channelId, filename, analysis) {
  if (!global.userUploads[userId]) global.userUploads[userId] = [];
  global.userUploads[userId].push({
    filename, channelId, analysis,
    timestamp: new Date().toISOString(),
    reminderSent: false,
  });
  if (!global.weeklyStats[userId]) global.weeklyStats[userId] = { tracks: 0, issues: [], genres: [] };
  global.weeklyStats[userId].tracks++;
  if (analysis.energy < 50) global.weeklyStats[userId].issues.push('Low energy');
  if (analysis.bass_ratio > 60) global.weeklyStats[userId].issues.push('Heavy bass');
}

// ─── GROQ AI ─────────────────────────────────────────────
async function askAI(prompt) {
  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: 'You are Wavmind, an expert AI assistant for music producers. Format using Slack mrkdwn. Use *text* for bold. Use • for bullets. Never use ** or # headers.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 1024,
    });
    let text = response.choices[0].message.content;
    text = text.replace(/#{1,6}\s+/g, '');
    text = text.replace(/\*\*([^*]+)\*\*/g, '*$1*');
    text = text.replace(/^-\s+/gm, '• ');
    return text;
  } catch (err) {
    console.error('Groq error:', err.message);
    return null;
  }
}

// ─── TAVILY ──────────────────────────────────────────────
async function tavilySearch(query) {
  try {
    const res = await axios.post('https://api.tavily.com/search',
      { api_key: process.env.TAVILY_API_KEY, query, search_depth: 'basic', max_results: 5, include_answer: true },
      { timeout: 10000 }
    );
    return {
      answer: res.data.answer || null,
      results: (res.data.results || []).map(r => ({ title: r.title, url: r.url })),
    };
  } catch (err) { console.error('Tavily error:', err.message); return null; }
}

// ─── FREESOUND ────────────────────────────────────────────
async function searchFreesound(query) {
  try {
    const clean = query.replace(/\b(loop|loops|sample|samples|pack)\b/gi, '').replace(/\b(\d+bpm|bpm)\b/gi, '').trim().split(' ').slice(0, 3).join(' ');
    const url = `https://freesound.org/apiv2/search/text/?query=${encodeURIComponent(clean || query)}&token=${process.env.FREESOUND_API_KEY}&format=json&page_size=10&fields=id,name,tags,duration,license,username,previews,avg_rating,num_downloads&filter=duration:[1+TO+30]`;
    const res = await axios.get(url, { timeout: 10000 });
    return (res.data.results || []).map(s => ({
      id: s.id, name: s.name,
      duration: Math.round((s.duration || 0) * 10) / 10,
      license: s.license?.includes('publicdomain') ? 'CC0 — Free' : 'CC Attribution',
      username: s.username,
      preview: s.previews?.['preview-hq-mp3'] || null,
      url: `https://freesound.org/people/${s.username}/sounds/${s.id}/`,
      downloads: s.num_downloads || 0,
      rating: s.avg_rating ? Math.round(s.avg_rating * 10) / 10 : 0,
      tags: (s.tags || []).slice(0, 6).join(' · '),
    }));
  } catch (err) { console.error('Freesound error:', err.message); return null; }
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
    return { name: track.name, artist: track.artists[0].name, bpm: Math.round(features.data.tempo), key: keys[features.data.key] + ' ' + ['Minor','Major'][features.data.mode], energy: Math.round(features.data.energy * 100), danceability: Math.round(features.data.danceability * 100), loudness: features.data.loudness.toFixed(1), valence: Math.round(features.data.valence * 100) };
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
    return { name: artistName, bpm: avg('tempo'), energy: Math.round(avg('energy')), danceability: Math.round(avg('danceability')), valence: Math.round(avg('valence')), loudness: (features.reduce((s,f)=>s+f.loudness,0)/features.length).toFixed(1), key: keys[Math.abs(avg('key'))%12] + ' ' + ['Minor','Major'][avg('mode')>0?1:0] };
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
const btn = (text, actionId, style) => { const b = { type: 'button', text: { type: 'plain_text', text, emoji: true }, action_id: actionId }; if (style) b.style = style; return b; };
const actions = btns => ({ type: 'actions', elements: btns });

// ─── SESSIONS ────────────────────────────────────────────
global.compareSessions = global.compareSessions || {};
const getCompareSession = id => global.compareSessions[id] || null;
const startCompareSession = id => { global.compareSessions[id] = { status: 'waiting_your_track', yourTrack: null, referenceTrack: null, startedAt: new Date().toISOString() }; return global.compareSessions[id]; };
const clearCompareSession = id => { delete global.compareSessions[id]; };

global.collabSessions = global.collabSessions || {};
const getCollabSession = id => global.collabSessions[id] || null;
const startCollabSession = (channelId, trackName, userId) => { global.collabSessions[channelId] = { trackName, startedBy: userId, startedAt: new Date().toISOString(), ideas: [], feedback: [], decisions: [] }; return global.collabSessions[channelId]; };
const endCollabSession = id => { const s = global.collabSessions[id]; delete global.collabSessions[id]; return s; };

// ─── WELCOME BLOCKS ───────────────────────────────────────
function getWelcomeBlocks() {
  return [
    header('🎛️ Wavmind — AI Producer Agent'),
    section('Everything you need to make better music, inside Slack.'),
    divider(),
    section('*🆚 Audio Comparison*\n`/wavmind mix compare start`\n_Upload your track + reference → instant gap analysis_'),
    section('*🔍 Reference Analysis*\n`/wavmind reference [track - artist]`\n_Example: `/wavmind reference Blinding Lights - The Weeknd`_'),
    section('*🎹 DAW Help*\n`/wavmind daw [daw] [question]`\n_Example: `/wavmind daw fl studio how to sidechain 808`_'),
    section('*🎵 Free Samples*\n`/wavmind samples [keywords]`\n_Example: `/wavmind samples drums` · `/wavmind samples piano`_'),
    section('*🎚️ Mix Feedback*\n`/wavmind feedback [describe your mix]`\n_Or upload MP3/WAV → `/wavmind mixfeedback bpm:140 key:F_minor`_'),
    section('*🎤 Artist DNA*\n`/wavmind compare [artist1] and [artist2]`\n_Example: `/wavmind compare Drake and Travis Scott`_'),
    section('*🎯 A&R Evaluation*\n`/wavmind ar [describe your track]`'),
    section('*🤝 Collab Mode*\n`/wavmind collab start "Track Name"` · `idea` · `feedback` · `decision` · `summary` · `end`'),
    divider(),
    section('*🎛️ Production Tools*\n`/wavmind ideas [genre]` — Track concepts\n`/wavmind bpm [genre]` — BPM, key & structure\n`/wavmind chords [key + genre]` — Chord progressions\n`/wavmind tips [topic]` — Expert tips'),
    divider(),
    context('💬 @mention Wavmind · Type `/wavmind` anytime for this menu'),
  ];
}

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
        // ── HERO ──
        section('*🎛️ Wavmind*\n_Your autonomous AI music production agent_'),
        divider(),

        // ── ACTIVITY CARD (if user has uploaded) ──
        ...(lastUpload ? [
          header('📊 Your Last Session'),
          twoCol(
            `🎵 *Last Track*\n${lastUpload.filename}`,
            `⚡ *Energy*\n${lastUpload.analysis.energy}%`
          ),
          twoCol(
            `🔊 *Bass*\n${lastUpload.analysis.bass_ratio}%`,
            `🌈 *Brightness*\n${lastUpload.analysis.brightness}`
          ),
          section(`_Uploaded ${new Date(lastUpload.timestamp).toLocaleDateString()}_`),
          actions([
            btn('🆚 Compare with Reference', 'quick_compare', 'primary'),
            btn('🎚️ Get Mix Feedback', 'quick_feedback'),
          ]),
          divider(),
        ] : []),

        // ── WEEKLY STATS (if available) ──
        ...(stats && stats.tracks > 0 ? [
          header('📈 Your Week'),
          twoCol(
            `🎵 *Tracks Analyzed*\n${stats.tracks}`,
            `⚠️ *Common Issue*\n${stats.issues[0] || 'None detected'}`
          ),
          divider(),
        ] : []),

        // ── 4 FEATURE SECTIONS ──
        header('🔬 Analyze'),
        twoCol(
          '*🆚 Audio Comparison*\nUpload your track + reference → side-by-side gap report with AI fix recommendations\n\n`/wavmind mix compare start`',
          '*🔍 Reference Track*\nGet real Spotify audio data + full production blueprint for any song\n\n`/wavmind reference [track]`'
        ),
        divider(),

        header('🎹 Create'),
        twoCol(
          '*🎹 DAW Knowledge*\nReal-time tutorials powered by Tavily web search + Groq AI\n\n`/wavmind daw [daw] [question]`',
          '*🎵 Free Samples*\nSearch 500,000+ Creative Commons sounds from Freesound.org\n\n`/wavmind samples [keywords]`'
        ),
        twoCol(
          '*🎚️ Mix Feedback*\nDescribe your mix or upload audio for professional AI mixing advice\n\n`/wavmind feedback [describe]`',
          '*🎛️ Production Tools*\nTrack ideas · BPM & key · Chord progressions · Expert tips\n\n`/wavmind ideas` · `/wavmind bpm` · `/wavmind chords`'
        ),
        divider(),

        header('📈 Develop'),
        twoCol(
          '*🎤 Artist DNA*\nCompare two artists using real Spotify production data\n\n`/wavmind compare [artist1] and [artist2]`',
          '*🎯 A&R Evaluation*\nGet an honest label executive assessment of your track\'s commercial potential\n\n`/wavmind ar [describe track]`'
        ),
        divider(),

        header('🤝 Collaborate'),
        section('*🤝 Collab Mode* — Track everything your team discusses about a song\n\n`/wavmind collab start "Track Name"` — Start session\n`/wavmind collab idea [idea]` — Log ideas\n`/wavmind collab feedback [fb]` — Log feedback\n`/wavmind collab decision [dec]` — Log decisions\n`/wavmind collab summary` — AI summary\n`/wavmind collab end` — End session'),
        divider(),

        // ── HOW TO USE AUDIO ──
        header('🎛️ Audio Upload Workflow'),
        section('*Quick mix check:*\n① Upload MP3/WAV → Wavmind scans it automatically\n② Run `/wavmind mixfeedback bpm:85 key:F_minor` for deep feedback\n\n*Compare with reference:*\n① `/wavmind mix compare start`\n② Upload your track\n③ Upload reference track\n④ Get instant gap report + AI recommendations'),
        context('💡 Key format: `C_major` · `F_minor` · `G_major` · `A_minor` · `Bb_major`'),
        divider(),

        // ── DAW EXAMPLES ──
        header('🎹 DAW Knowledge Examples'),
        section('`/wavmind daw fl studio how to sidechain 808`\n`/wavmind daw ableton how to warp audio`\n`/wavmind daw logic pro how to use flex pitch`\n`/wavmind daw pro tools how to set up sessions`\n`/wavmind daw cubase how to use chord track`'),
        context('FL Studio · Ableton Live · Logic Pro · Pro Tools · Cubase · Studio One · GarageBand · Reaper · Bitwig'),
        divider(),

        // ── POWERED BY ──
        header('⚡ Powered By'),
        twoCol('🤖 *Groq AI* — Llama 3.1', '🎵 *Spotify* — Real audio data'),
        twoCol('🔍 *Tavily* — Real-time search', '🎵 *Freesound* — 500K+ samples'),
        twoCol('🎧 *Librosa* — Audio analysis', '🔌 *MCP Server* — AI agent tools'),
        divider(),
        context('🎛️ *Wavmind* — Type `/wavmind` in any channel to get started'),
      ],
    },
  });
}

app.event('app_home_opened', async ({ event, client }) => {
  try { await publishAppHome(client, event.user); } catch (err) { console.error('Home error:', err.message); }
});

// ─── BUTTON HANDLERS ─────────────────────────────────────
app.action('quick_compare', async ({ body, ack, client }) => {
  await ack();
  startCompareSession(body.user.id);
  await client.chat.postMessage({
    channel: body.user.id,
    blocks: [
      header('🆚 Comparison Started!'),
      section('Upload your track first, then your reference track.\n\nWavmind will compare both automatically.'),
      context('Cancel anytime: `/wavmind mix compare cancel`'),
    ],
  });
});

app.action('quick_feedback', async ({ body, ack, client }) => {
  await ack();
  await client.chat.postMessage({
    channel: body.user.id,
    blocks: [
      header('🎚️ Mix Feedback'),
      section('Describe your mix and I\'ll give you professional feedback:\n\n`/wavmind feedback [describe your mix]`\n\n*Example:*\n`/wavmind feedback my trap beat at 140bpm feels muddy`'),
    ],
  });
});

// ─── SLACK AI ASSISTANT ───────────────────────────────────
app.event('assistant_thread_started', async ({ event, say }) => {
  try {
    await say({
      text: '🎛️ *Wavmind AI* is ready!\n\nAsk me anything about music production:\n• How to mix 808s\n• DAW tutorials\n• Track ideas\n• Mixing techniques\n• Music theory\n\nOr use `/wavmind` for all commands.',
    });
  } catch (err) { console.error('Assistant error:', err.message); }
});

app.event('assistant_thread_context_changed', async ({ event }) => {
  // Context updated — no action needed
});

app.message(async ({ message, say, client }) => {
  if (message.subtype || !message.text) return;
  const lower = message.text.toLowerCase().trim();

  // Handle Slack AI assistant messages
  if (message.channel_type === 'im' || message.thread_ts) {
    if (['hi','hello','hey','start','help'].includes(lower)) {
      await say({ blocks: getWelcomeBlocks() });
      return;
    }
    const response = await askAI(`You are Wavmind, expert AI for music producers. Answer this question professionally and specifically: "${message.text}"`);
    await say({ blocks: [section(response || 'Could not respond. Try again!'), context('`/wavmind` for all commands')] });
    return;
  }

  // ─── AUTONOMOUS CHANNEL MONITORING ───────────────────
  // Listen for music production keywords and jump in
  const musicKeywords = ['muddy', '808', 'sidechain', 'compress', 'eq ', 'reverb', 'delay', 'mix', 'master', 'beat', 'plugin', 'vst', 'sample', 'bpm', 'fl studio', 'ableton', 'logic pro', 'pro tools', 'cubase', 'melody', 'chord', 'bass line', 'hi-hat', 'kick drum', 'snare'];
  const hasKeyword = musicKeywords.some(kw => lower.includes(kw));

  if (hasKeyword && !lower.startsWith('/')) {
    // Only respond occasionally to avoid being annoying (1 in 3 chance)
    const shouldRespond = Math.random() < 0.33;
    if (!shouldRespond) return;

    try {
      const response = await askAI(`A music producer said: "${message.text}". Give a very brief (2-3 sentence) helpful tip related to what they mentioned. End with one relevant Wavmind command they could use. Keep it natural and conversational.`);
      if (response) {
        await say({
          thread_ts: message.ts,
          blocks: [
            section(`🎛️ *Wavmind tip:* ${response}`),
            context('💡 Type `/wavmind` for all features · React with ✅ if this helped'),
          ],
        });
      }
    } catch (err) { console.error('Channel monitor error:', err.message); }
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

    // ─── COMPARISON MODE ─────────────────────────────────
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
            header('🎯 Now Upload Your Reference Track'),
            section('Upload the song you want to sound like.'),
            context('⏳ Step 2 of 2'),
          ],
        });

      } else if (compareSession.status === 'waiting_reference') {
        await client.chat.postMessage({ channel: channelId, blocks: [header('🔍 Scanning Reference...'), section(`*File:* ${file.name}`), context('⏳ Generating report...')] });
        const analysis = await analyzeAudioFile(file.url_private_download, file.name);
        if (!analysis || analysis.error) { await client.chat.postMessage({ channel: channelId, blocks: [header('❗ Scan Failed'), section('Try MP3 under 10MB.')] }); return; }
        compareSession.referenceTrack = { filename: file.name, energy: analysis.energy, brightness: analysis.brightness, bass_ratio: analysis.bass_ratio, duration: analysis.duration };
        const yours = compareSession.yourTrack;
        const ref = compareSession.referenceTrack;
        const energyDiff = ref.energy - yours.energy;
        const bassDiff = ref.bass_ratio - yours.bass_ratio;
        const bMap = { 'Dark (heavy low end)': 1, 'Balanced': 2, 'Bright (strong high end)': 3 };
        const brightDiff = (bMap[ref.brightness] || 2) - (bMap[yours.brightness] || 2);
        const yourMins = Math.floor(yours.duration / 60); const yourSecs = String(yours.duration % 60).padStart(2, '0');
        const refMins = Math.floor(ref.duration / 60); const refSecs = String(ref.duration % 60).padStart(2, '0');
        const aiAnalysis = await askAI(`Professional mixing engineer comparison:
YOUR TRACK "${yours.filename}": Energy ${yours.energy}%, Brightness ${yours.brightness}, Bass ${yours.bass_ratio}%
REFERENCE "${ref.filename}": Energy ${ref.energy}%, Brightness ${ref.brightness}, Bass ${ref.bass_ratio}%
Energy gap: ${Math.abs(energyDiff)}% ${energyDiff > 0 ? '(ref higher)' : '(yours higher)'}
Bass gap: ${Math.abs(bassDiff)}% ${bassDiff > 0 ? '(ref heavier)' : '(yours heavier)'}
Brightness: ${brightDiff > 0 ? 'Ref brighter' : brightDiff < 0 ? 'Yours brighter' : 'Matched'}
Give specific EQ, compression, bass treatment to close each gap. Top 3 most important changes. Real plugin names.`);
        clearCompareSession(userId);
        await client.chat.postMessage({
          channel: channelId,
          blocks: [
            header('🆚 Mix Comparison Report'),
            divider(),
            twoCol(`🎵 *Your Track*\n${yours.filename}`, `🎯 *Reference*\n${ref.filename}`),
            divider(),
            section('📊 *Side-by-Side Analysis*'),
            twoCol(`⚡ *Your Energy*\n${yours.energy}%`, `⚡ *Ref Energy*\n${ref.energy}%  ${Math.abs(energyDiff) <= 5 ? '✅' : energyDiff > 0 ? '⚠️ Ref higher' : '✅ Yours higher'}`),
            twoCol(`🔊 *Your Bass*\n${yours.bass_ratio}%`, `🔊 *Ref Bass*\n${ref.bass_ratio}%  ${Math.abs(bassDiff) <= 5 ? '✅' : bassDiff > 0 ? '⚠️ Ref heavier' : '✅ Yours heavier'}`),
            twoCol(`🌈 *Your Brightness*\n${yours.brightness}`, `🌈 *Ref Brightness*\n${ref.brightness}  ${brightDiff === 0 ? '✅' : '⚠️ Gap'}`),
            twoCol(`⏱️ *Your Duration*\n${yourMins}:${yourSecs}`, `⏱️ *Ref Duration*\n${refMins}:${refSecs}`),
            divider(),
            header('🤖 AI Gap Analysis'),
            section(aiAnalysis || 'Could not generate.'),
            divider(),
            section('*Next Steps:*\n• Apply the EQ and compression changes above\n• Re-export and run `/wavmind mix compare start` again to check progress'),
            context('`/wavmind mix compare start` to run again'),
          ],
        });
      }
      return;
    }

    // ─── NORMAL UPLOAD + TRACK (for reminders) ───────────
    await client.chat.postMessage({ channel: channelId, blocks: [header('🎵 Scanning...'), section(`*File:* ${file.name}`), context('⏳ Analyzing...')] });
    const analysis = await analyzeAudioFile(file.url_private_download, file.name);
    if (!analysis || analysis.error) {
      await client.chat.postMessage({ channel: channelId, blocks: [header('❗ Scan Failed'), section('Try MP3 under 10MB.')] });
      return;
    }

    // Track upload for automation
    if (userId) trackUpload(userId, channelId, file.name, analysis);

    global.pendingAnalysis = global.pendingAnalysis || {};
    global.pendingAnalysis[channelId] = { filename: file.name, energy: analysis.energy, brightness: analysis.brightness, bass_ratio: analysis.bass_ratio, duration: analysis.duration };

    const mins = Math.floor(analysis.duration / 60);
    const secs = String(analysis.duration % 60).padStart(2, '0');

    const issues = [];
    if (analysis.energy < 50) issues.push('⚠️ Low energy — your mix may lack punch');
    if (analysis.bass_ratio > 65) issues.push('⚠️ Heavy bass — may sound muddy on small speakers');
    if (analysis.bass_ratio < 20) issues.push('⚠️ Thin bass — consider adding more low end');

    await client.chat.postMessage({
      channel: channelId,
      blocks: [
        header('🎛️ Scan Complete'),
        section(`*File:* ${file.name}`),
        divider(),
        twoCol(`⚡ *Energy*\n${analysis.energy}%`, `🌈 *Brightness*\n${analysis.brightness}`),
        twoCol(`🔊 *Bass*\n${analysis.bass_ratio}%`, `⏱️ *Duration*\n${mins}:${secs}`),
        ...(issues.length > 0 ? [divider(), section(`*⚡ Quick Insights:*\n${issues.join('\n')}`)] : []),
        divider(),
        section('*What would you like to do?*\n\n• Deep mix feedback: `/wavmind mixfeedback bpm:85 key:F_minor`\n• Compare with reference: `/wavmind mix compare start`'),
        context('💡 Wavmind will send you a reminder in 24hrs to check your progress'),
      ],
    });

    // ─── SCHEDULE 24HR REMINDER ──────────────────────────
    if (userId) {
      setTimeout(async () => {
        try {
          const uploads = global.userUploads[userId] || [];
          const thisUpload = uploads.find(u => u.filename === file.name && !u.reminderSent);
          if (!thisUpload) return;
          thisUpload.reminderSent = true;

          const issues = [];
          if (thisUpload.analysis.energy < 50) issues.push('☐ Low energy — needs more punch');
          if (thisUpload.analysis.bass_ratio > 65) issues.push('☐ Heavy bass — check on small speakers');
          if (thisUpload.analysis.bass_ratio < 20) issues.push('☐ Thin bass — add more low end');

          await client.chat.postMessage({
            channel: userId, // DM the user
            blocks: [
              header('🎛️ Wavmind Reminder'),
              section(`Hey! You uploaded *"${file.name}"* yesterday.\n\nHave you fixed these issues yet?`),
              divider(),
              ...(issues.length > 0 ? [section(`*Pending fixes:*\n${issues.join('\n')}`)] : [section('Your track looked good! Ready to release?')]),
              divider(),
              section('*Ready to check your progress?*\n\n`/wavmind mix compare start` — Compare with a reference\n`/wavmind mixfeedback bpm:140 key:F_minor` — Get fresh feedback'),
              context('🤖 This is an autonomous reminder from Wavmind'),
            ],
          });
        } catch (err) { console.error('Reminder error:', err.message); }
      }, 24 * 60 * 60 * 1000); // 24 hours
    }

  } catch (err) { console.error('File error:', err.message); }
});

// ─── WEEKLY DIGEST SCHEDULER ─────────────────────────────
function scheduleWeeklyDigest(client) {
  const sendDigest = async () => {
    try {
      const userIds = Object.keys(global.weeklyStats);
      for (const userId of userIds) {
        const stats = global.weeklyStats[userId];
        if (stats.tracks === 0) continue;

        const topIssue = stats.issues.length > 0
          ? stats.issues.sort((a,b) => stats.issues.filter(i=>i===b).length - stats.issues.filter(i=>i===a).length)[0]
          : 'None detected';

        const aiTip = await askAI(`A music producer analyzed ${stats.tracks} tracks this week. Most common issue: ${topIssue}. Give them one specific actionable improvement tip for next week. Under 50 words.`);

        await client.chat.postMessage({
          channel: userId,
          blocks: [
            header('📊 Your Weekly Production Report'),
            section(`*Week ending ${new Date().toLocaleDateString()}*`),
            divider(),
            twoCol(`🎵 *Tracks Analyzed*\n${stats.tracks}`, `⚠️ *Most Common Issue*\n${topIssue}`),
            divider(),
            section(`*🤖 Wavmind Recommendation:*\n${aiTip || 'Keep producing consistently!'}`),
            divider(),
            section('*This week try:*\n`/wavmind mix compare start` — Compare your mix\n`/wavmind daw [daw] [question]` — Learn a new technique\n`/wavmind samples drums` — Find fresh sounds'),
            context('📊 Automated weekly report from Wavmind · Every Monday'),
          ],
        });

        // Reset weekly stats
        global.weeklyStats[userId] = { tracks: 0, issues: [], genres: [] };
      }
    } catch (err) { console.error('Weekly digest error:', err.message); }
  };

  // Calculate ms until next Monday 9am
  const now = new Date();
  const nextMonday = new Date();
  nextMonday.setDate(now.getDate() + ((1 + 7 - now.getDay()) % 7 || 7));
  nextMonday.setHours(9, 0, 0, 0);
  const msUntilMonday = nextMonday - now;

  setTimeout(() => {
    sendDigest();
    setInterval(sendDigest, 7 * 24 * 60 * 60 * 1000); // every week
  }, msUntilMonday);

  console.log(`📅 Weekly digest scheduled for ${nextMonday.toLocaleString()}`);
}

// ─── SLASH COMMANDS ───────────────────────────────────────
app.command('/wavmind', async ({ command, ack, respond, client }) => {
  await ack();
  const input = command.text.trim();
  const lower = input.toLowerCase();
  const userId = command.user_id;

  if (!input || lower === 'help') {
    await respond({ response_type: 'ephemeral', blocks: getWelcomeBlocks() });
    return;
  }

  // ─── MCP INFO ────────────────────────────────────────
  if (lower === 'mcp') {
    const base = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'http://localhost:3000';
    await respond({
      blocks: [
        header('🔌 Wavmind MCP Server'),
        section('Wavmind exposes its tools via MCP so any AI agent can connect.'),
        divider(),
        section('*Available Tools:*\n• `search_samples` — Freesound 500K+ samples\n• `get_track_features` — Spotify audio data\n• `analyze_mix` — AI mixing feedback\n• `get_daw_help` — DAW tutorials\n• `compare_artists` — Artist DNA\n• `get_track_ideas` — Track concepts'),
        divider(),
        section(`*Endpoints:*\n• \`GET ${base}/mcp/tools\` — List tools\n• \`POST ${base}/mcp/execute\` — Run tool\n• \`GET ${base}/health\` — Health check`),
        context('🔌 Compatible with Claude, GPT and any MCP client'),
      ],
    });
    return;
  }

  // ─── MIX COMPARE ─────────────────────────────────────
  if (lower.startsWith('mix compare') || lower.startsWith('mix-compare')) {
    if (lower.includes('cancel')) {
      clearCompareSession(userId);
      await respond({ blocks: [header('🗑️ Cancelled'), section('`/wavmind mix compare start` to start again')] });
      return;
    }
    if (getCompareSession(userId)) {
      const s = getCompareSession(userId);
      await respond({ blocks: [header('⚠️ Session Active'), section(`Status: ${s.status === 'waiting_your_track' ? 'Upload your track' : 'Upload reference track'}\n\nCancel: \`/wavmind mix compare cancel\``)] });
      return;
    }
    startCompareSession(userId);
    await respond({
      response_type: 'in_channel',
      blocks: [
        header('🆚 Mix Comparison Started'),
        section(`*<@${userId}>* here's what to do:`),
        divider(),
        section('*Step 1* — Upload YOUR track (the one you\'re working on)'),
        section('*Step 2* — Upload your REFERENCE track (the song you want to sound like)'),
        section('*Step 3* — Wavmind automatically compares both and gives you:\n• Side-by-side energy, bass, brightness\n• ✅ Match or ⚠️ Gap for each element\n• Specific AI advice to close each gap'),
        divider(),
        context('Upload your track now · Cancel: `/wavmind mix compare cancel`'),
      ],
    });
    return;
  }

  // ─── DAW ─────────────────────────────────────────────
  if (lower.startsWith('daw')) {
    const dawInput = input.slice(3).trim();
    if (!dawInput) {
      await respond({ blocks: [header('🎹 DAW Knowledge'), section('`/wavmind daw [daw] [question]`\n\n*Examples:*\n`/wavmind daw fl studio how to sidechain 808`\n`/wavmind daw ableton how to warp audio`\n`/wavmind daw logic pro flex pitch`'), context('FL Studio · Ableton · Logic Pro · Pro Tools · Cubase · Studio One · GarageBand · Reaper')] });
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
    if (!detectedDAW) { await respond({ blocks: [header('❗ DAW Not Recognized'), section('`/wavmind daw fl studio how to sidechain`'), context('Supported: FL Studio · Ableton · Logic Pro · Pro Tools · Cubase · Studio One')] }); return; }
    await respond({ blocks: [header(`🎹 ${detectedDAW}...`), section(`*Q:* ${question}`), context('⏳ Tavily + AI...')] });
    const [tav, ai] = await Promise.all([
      tavilySearch(`${detectedDAW} ${question} tutorial step by step`),
      askAI(`Expert ${detectedDAW} instructor. Answer: "${question}". Numbered steps, bold key terms.`),
    ]);
    const blocks = [header(`🎹 ${detectedDAW}: ${question}`), divider(), section('🤖 *AI Answer:*'), section(ai || 'Error')];
    if (tav?.answer) blocks.push(divider(), section('🌐 *From the Web:*'), section(tav.answer));
    if (tav?.results?.length) blocks.push(divider(), section('📚 *Resources:*'), section(tav.results.slice(0,4).map(r=>`• <${r.url}|${r.title}>`).join('\n')));
    blocks.push(context(`🎹 ${detectedDAW} · Tavily + Groq`));
    await respond({ blocks });
    return;
  }

  // ─── SAMPLES ─────────────────────────────────────────
  if (lower.startsWith('samples')) {
    const query = input.slice(7).trim();
    if (!query) { await respond({ blocks: [header('🎵 Free Samples'), section('`/wavmind samples drums`\n`/wavmind samples piano`\n`/wavmind samples bass`\n`/wavmind samples synth`\n`/wavmind samples ambient`'), context('Creative Commons — free to use')] }); return; }
    await respond({ blocks: [header('🎵 Searching...'), section(`*"${query}"*`), context('⏳')] });
    const sounds = await searchFreesound(query);
    if (!sounds || !sounds.length) {
      const simple = query.split(' ')[0];
      const retry = simple !== query ? await searchFreesound(simple) : null;
      if (retry?.length) {
        const blocks = [header(`🎵 Results for "${simple}"`), section(`_No exact results for "${query}"_`), divider()];
        retry.forEach((s,i) => { blocks.push(section(`*${i+1}. ${s.name}*\n⏱️ ${s.duration}s · ⭐ ${s.rating}/5 · 📄 ${s.license}\n👤 ${s.username}\n${s.preview?`🔊 *<${s.preview}|▶ Listen>*  `:''}🔗 *<${s.url}|📥 Download>*`)); if(i<retry.length-1) blocks.push(divider()); });
        await respond({ blocks });
      } else {
        await respond({ blocks: [header('❗ No Results'), section(`Try simpler: \`/wavmind samples drums\``), section(`🔗 *<https://freesound.org/search/?q=${encodeURIComponent(query)}|Browse Freesound>*`)] });
      }
      return;
    }
    const aiTip = await askAI(`Producer found "${query}" samples: ${sounds.slice(0,3).map(s=>s.name).join(', ')}. 2-3 production tips. Under 60 words. Bullets.`);
    const blocks = [header(`🎵 Samples: "${query}"`), section(`*${sounds.length} sounds* — all free`), context('Click Listen to preview · Click Download for file'), divider()];
    sounds.forEach((s,i) => { blocks.push(section(`*${i+1}. ${s.name}*\n⏱️ *${s.duration}s* · ⭐ *${s.rating}/5* · 📥 *${s.downloads.toLocaleString()}*\n📄 ${s.license} · 👤 ${s.username}\n🏷️ ${s.tags}\n\n${s.preview?`🔊 *<${s.preview}|▶ Listen>*     `:''}🔗 *<${s.url}|📥 Download>*`)); if(i<sounds.length-1) blocks.push(divider()); });
    if (aiTip) blocks.push(divider(), header('💡 Tips'), section(aiTip));
    blocks.push(divider(), section(`🔗 *<https://freesound.org/search/?q=${encodeURIComponent(query)}|Browse more on Freesound>*`), context('🎵 Creative Commons · Freesound.org'));
    await respond({ blocks });
    return;
  }

  // ─── COLLAB ──────────────────────────────────────────
  if (lower.startsWith('collab')) {
    const sub = input.slice(6).trim(); const subL = sub.toLowerCase();
    if (subL.startsWith('start')) {
      const name = sub.slice(5).trim().replace(/['"]/g,'') || 'Untitled';
      if (getCollabSession(command.channel_id)) { await respond({ blocks: [header('⚠️ Active'), section('`/wavmind collab end` first')] }); return; }
      startCollabSession(command.channel_id, name, userId);
      await respond({ response_type: 'in_channel', blocks: [header('🤝 Collab Started'), section(`*Track:* "${name}"\n*By:* <@${userId}>`), divider(), twoCol('💡 `/wavmind collab idea [idea]`','🎚️ `/wavmind collab feedback [fb]`'), twoCol('✅ `/wavmind collab decision [dec]`','📋 `/wavmind collab summary`'), context('`/wavmind collab end` to finish')] });
      return;
    }
    if (subL.startsWith('idea')) { const t=sub.slice(4).trim(); const s=getCollabSession(command.channel_id); if(!s){await respond({blocks:[header('❗ No Session'),section('`/wavmind collab start "Name"`')]}); return;} if(!t){await respond({blocks:[header('❗ Missing'),section('`/wavmind collab idea [idea]`')]}); return;} s.ideas.push({text:t,user:userId,time:new Date().toISOString()}); await respond({response_type:'in_channel',blocks:[header('💡 Idea Logged'),section(`*"${t}"* — <@${userId}>`),context(`${s.ideas.length} ideas for "${s.trackName}"`)]}); return; }
    if (subL.startsWith('feedback')) { const t=sub.slice(8).trim(); const s=getCollabSession(command.channel_id); if(!s){await respond({blocks:[header('❗ No Session'),section('`/wavmind collab start "Name"`')]}); return;} if(!t){await respond({blocks:[header('❗ Missing'),section('`/wavmind collab feedback [fb]`')]}); return;} s.feedback.push({text:t,user:userId,time:new Date().toISOString()}); await respond({response_type:'in_channel',blocks:[header('🎚️ Feedback Logged'),section(`*"${t}"* — <@${userId}>`),context(`${s.feedback.length} feedback for "${s.trackName}"`)]}); return; }
    if (subL.startsWith('decision')) { const t=sub.slice(8).trim(); const s=getCollabSession(command.channel_id); if(!s){await respond({blocks:[header('❗ No Session'),section('`/wavmind collab start "Name"`')]}); return;} if(!t){await respond({blocks:[header('❗ Missing'),section('`/wavmind collab decision [dec]`')]}); return;} s.decisions.push({text:t,user:userId,time:new Date().toISOString()}); await respond({response_type:'in_channel',blocks:[header('✅ Decision Logged'),section(`*"${t}"* — <@${userId}>`),context(`${s.decisions.length} decisions for "${s.trackName}"`)]}); return; }
    if (subL.startsWith('status')) { const s=getCollabSession(command.channel_id); if(!s){await respond({blocks:[header('❗ No Session')]}); return;} await respond({blocks:[header('📊 Status'),section(`*"${s.trackName}"* by <@${s.startedBy}>`),divider(),twoCol(`💡 ${s.ideas.length} ideas`,`🎚️ ${s.feedback.length} feedback`),twoCol(`✅ ${s.decisions.length} decisions`,`⏱️ ${new Date(s.startedAt).toLocaleTimeString()}`),context('`/wavmind collab summary` · `/wavmind collab end`')]}); return; }
    if (subL.startsWith('summary')) { const s=getCollabSession(command.channel_id); if(!s){await respond({blocks:[header('❗ No Session')]}); return;} const r=await askAI(`Summarize collab for "${s.trackName}": IDEAS: ${s.ideas.map(i=>i.text).join(', ')||'None'} FEEDBACK: ${s.feedback.map(f=>f.text).join(', ')||'None'} DECISIONS: ${s.decisions.map(d=>d.text).join(', ')||'None'}. Overview, directions, next steps.`); await respond({response_type:'in_channel',blocks:[header('📋 Summary'),section(`*"${s.trackName}"*`),divider(),twoCol(`💡 ${s.ideas.length}`,`🎚️ ${s.feedback.length}`),divider(),section(r||'Error'),context('`/wavmind collab end` to finish')]}); return; }
    if (subL.startsWith('end')) { const s=getCollabSession(command.channel_id); if(!s){await respond({blocks:[header('❗ No Session')]}); return;} const r=await askAI(`Final report for "${s.trackName}": IDEAS: ${s.ideas.map(i=>i.text).join(', ')||'None'} FEEDBACK: ${s.feedback.map(f=>f.text).join(', ')||'None'} DECISIONS: ${s.decisions.map(d=>d.text).join(', ')||'None'}. Overview, decisions, action items.`); endCollabSession(command.channel_id); await respond({response_type:'in_channel',blocks:[header('🏁 Complete'),section(`*"${s.trackName}"*`),divider(),section(r||'Error'),context('`/wavmind collab start "Name"` for new session')]}); return; }
    await respond({ blocks: [header('🤝 Collab'), section('`start` · `idea` · `feedback` · `decision` · `summary` · `end`')] });
    return;
  }

  // ─── COMPARE ARTISTS ─────────────────────────────────
  if (lower.startsWith('compare')) {
    const artists = input.slice(7).trim();
    if (!artists || artists.split(' ').length < 2) { await respond({ blocks: [header('❗ Need Two Artists'), section('`/wavmind compare Drake and Travis Scott`')] }); return; }
    await respond({ blocks: [header('🔍 Comparing...'), context('⏳')] });
    let a1, a2;
    if (artists.toLowerCase().includes(' and ')) { [a1,a2]=artists.split(/\s+and\s+/i).map(s=>s.trim()); }
    else if (artists.toLowerCase().includes(' vs ')) { [a1,a2]=artists.split(/\s+vs\s+/i).map(s=>s.trim()); }
    else { const w=artists.split(' '); const m=Math.ceil(w.length/2); a1=w.slice(0,m).join(' '); a2=w.slice(m).join(' '); }
    const [s1,s2] = await Promise.all([getArtistStats(a1),getArtistStats(a2)]);
    if (!s1||!s2) { await respond({ blocks: [header('❗ Not Found'), section('`/wavmind compare Drake and Travis Scott`')] }); return; }
    const ai = await askAI(`Compare: ${s1.name} (BPM ${s1.bpm}, Energy ${s1.energy}%, Key ${s1.key}) vs ${s2.name} (BPM ${s2.bpm}, Energy ${s2.energy}%, Key ${s2.key}). Key differences, how to blend styles.`);
    await respond({
      blocks: [
        header('🎤 Artist DNA'),
        section(`*${s1.name}* vs *${s2.name}*`),
        divider(),
        { type: 'section', fields: [{ type: 'mrkdwn', text: `*${s1.name}*` }, { type: 'mrkdwn', text: `*${s2.name}*` }] },
        { type: 'section', fields: [{ type: 'mrkdwn', text: `🥁 BPM: *${s1.bpm}*` }, { type: 'mrkdwn', text: `🥁 BPM: *${s2.bpm}*` }] },
        { type: 'section', fields: [{ type: 'mrkdwn', text: `⚡ Energy: *${s1.energy}%*` }, { type: 'mrkdwn', text: `⚡ Energy: *${s2.energy}%*` }] },
        { type: 'section', fields: [{ type: 'mrkdwn', text: `💃 Dance: *${s1.danceability}%*` }, { type: 'mrkdwn', text: `💃 Dance: *${s2.danceability}%*` }] },
        { type: 'section', fields: [{ type: 'mrkdwn', text: `🔊 Loud: *${s1.loudness}dB*` }, { type: 'mrkdwn', text: `🔊 Loud: *${s2.loudness}dB*` }] },
        divider(),
        section(ai || 'Error'),
        context('`/wavmind reference [track]` for specific song analysis'),
      ],
    });
    return;
  }

  // ─── REFERENCE ───────────────────────────────────────
  if (lower.startsWith('reference')) {
    const q = input.slice(9).trim();
    if (!q) { await respond({ blocks: [header('❗ Missing'), section('`/wavmind reference Blinding Lights - The Weeknd`')] }); return; }
    await respond({ blocks: [header('🔍 Looking Up...'), section(`*${q}*`), context('⏳')] });
    const f = await getTrackFeatures(q);
    if (f) {
      const r = await askAI(`Advice on achieving sound of ${f.name} by ${f.artist}: BPM ${f.bpm}, Key ${f.key}, Energy ${f.energy}%, Loudness ${f.loudness}dB. Specific techniques and plugin names.`);
      await respond({ blocks: [header('🎵 Reference Analysis'), section(`*${f.name}* by *${f.artist}*`), divider(), twoCol(`🥁 *BPM*\n${f.bpm}`,`🎵 *Key*\n${f.key}`), twoCol(`⚡ *Energy*\n${f.energy}%`,`💃 *Dance*\n${f.danceability}%`), twoCol(`🔊 *Loudness*\n${f.loudness} dB`,`😊 *Valence*\n${f.valence}%`), divider(), section(r||'Error'), context('`/wavmind mix compare start` to compare your audio') ] });
    } else {
      const r = await askAI(`Blueprint for "${q}". Tempo, key, drums, bass, melody, mix approach.`);
      await respond({ blocks: [header('🎵 Reference Analysis'), section(`*${q}*`), divider(), section(r||'Error')] });
    }
    return;
  }

  // ─── FEEDBACK ────────────────────────────────────────
  if (lower.startsWith('feedback')) {
    const desc = input.slice(8).trim();
    if (!desc) { await respond({ blocks: [header('❗ Missing'), section('`/wavmind feedback My beat feels muddy at 140bpm`')] }); return; }
    await respond({ blocks: [header('🎚️ Analyzing...'), section(`_"${desc}"_`), context('⏳')] });
    const r = await askAI(`Professional mixing feedback for: "${desc}". EQ, compression, stereo width, frequency balance. Format with emojis and clear sections.`);
    await respond({ blocks: [header('🎚️ Mix Feedback'), section(`_${desc}_`), divider(), section(r||'Error'), context('Upload MP3/WAV then `/wavmind mixfeedback bpm:140 key:F_minor`')] });
    return;
  }

  // ─── MIXFEEDBACK ─────────────────────────────────────
  if (lower.startsWith('mixfeedback')) {
    const parts = input.slice(11).trim();
    const bpmM = parts.match(/bpm[:\s]+(\d+)/i); const keyM = parts.match(/key[:\s]+([\w#b_]+)/i);
    if (!bpmM||!keyM) { await respond({ blocks: [header('❗ Missing'), section('`/wavmind mixfeedback bpm:140 key:F_minor`')] }); return; }
    const bpm=parseInt(bpmM[1]); const key=keyM[1].replace(/_/g,' ');
    const stored=global.pendingAnalysis?.[command.channel_id];
    await respond({ blocks: [header('🎚️ Generating...'), twoCol(`🥁 *BPM*\n${bpm}`,`🎵 *Key*\n${key}`), context('⏳')] });
    const ctx=stored?`Energy: ${stored.energy}%, Brightness: ${stored.brightness}, Bass: ${stored.bass_ratio}%`:'';
    const r=await askAI(`Mix feedback: BPM ${bpm}, Key ${key}. ${ctx}. EQ, compression, arrangement. Real plugin names.`);
    if (global.pendingAnalysis?.[command.channel_id]) delete global.pendingAnalysis[command.channel_id];
    await respond({ blocks: [header('🎛️ Mix Feedback'), twoCol(`🥁 *BPM*\n${bpm}`,`🎵 *Key*\n${key}`), stored?twoCol(`⚡ *Energy*\n${stored.energy}%`,`🔊 *Bass*\n${stored.bass_ratio}%`):divider(), divider(), section(r||'Error'), context('`/wavmind mix compare start` to compare audio')] });
    return;
  }

  // ─── A&R ─────────────────────────────────────────────
  if (lower.startsWith('ar ') || lower === 'ar') {
    const desc = input.slice(2).trim();
    if (!desc) { await respond({ blocks: [header('❗ Missing'), section('`/wavmind ar Dark trap 140bpm heavy 808s`')] }); return; }
    await respond({ blocks: [header('🎯 A&R Evaluation...'), section(`_"${desc}"_`), context('⏳')] });
    const r = await askAI(`Senior A&R executive evaluation: "${desc}". Commercial Potential (1-10), Playlist Potential, Target Audience, Strengths, Weaknesses, Verdict. Be honest.`);
    await respond({ blocks: [header('🎯 A&R Evaluation'), section(`_${desc}_`), divider(), section(r||'Error')] });
    return;
  }

  // ─── RELEASE ─────────────────────────────────────────
  if (lower.startsWith('release')) {
    const desc = input.slice(7).trim();
    if (!desc) { await respond({ blocks: [header('❗ Missing'), section('`/wavmind release Trap beat 140bpm mixed`')] }); return; }
    const r = await askAI(`Release readiness: "${desc}". Mix Quality, Loudness LUFS, Metadata, Distribution, Strategy, Score X/10. Checklist ✅ or ⚠️.`);
    await respond({ blocks: [header('✅ Release Readiness'), section(`_${desc}_`), divider(), section(r||'Error')] });
    return;
  }

  // ─── PRODUCTION TOOLS ────────────────────────────────
  if (lower.startsWith('ideas')) {
    const genre=input.slice(5).trim()||'general';
    const r=await askAI(`5 creative track ideas for "${genre}". Format: 🎵 *Title* — concept.`);
    await respond({ blocks: [header('🎵 Track Ideas'), section(`*Genre:* ${genre}`), divider(), section(r||'Error'), context('`/wavmind bpm [genre]` · `/wavmind chords [key]`')] });
    return;
  }

  if (lower.startsWith('bpm')) {
    const mood=input.slice(3).trim()||'general';
    const r=await askAI(`For "${mood}": ideal BPM range, best keys, chord progressions, song structure. Specific numbers.`);
    await respond({ blocks: [header('🥁 BPM & Key'), section(`*Genre:* ${mood}`), divider(), section(r||'Error')] });
    return;
  }

  if (lower.startsWith('chords')) {
    const q=input.slice(6).trim()||'C minor trap';
    const r=await askAI(`3 chord progressions for "${q}". Each: chords, Roman numerals, feel, melody note.`);
    await respond({ blocks: [header('🎹 Chord Progressions'), section(`*${q}*`), divider(), section(r||'Error')] });
    return;
  }

  if (lower.startsWith('tips')) {
    const topic=input.slice(4).trim()||'music production';
    const r=await askAI(`5 professional tips about "${topic}". Real techniques and plugin names.`);
    await respond({ blocks: [header('💡 Production Tips'), section(`*${topic}*`), divider(), section(r||'Error')] });
    return;
  }

  // ─── GENERAL ─────────────────────────────────────────
  await respond({ blocks: [header('🤔 Thinking...'), context('⏳')] });
  const response = await askAI(`You are Wavmind, expert AI for music producers. Answer: "${input}"`);
  await respond({ blocks: [header('🎛️ Wavmind'), section(response||'Error'), context('`/wavmind` for all commands')] });
});

// ─── APP MENTION ──────────────────────────────────────────
app.event('app_mention', async ({ event, say }) => {
  const input = event.text.replace(/<@[^>]+>/g, '').trim();
  if (!input) { await say({ blocks: getWelcomeBlocks() }); return; }
  const r = await askAI(`You are Wavmind, expert AI for music producers. Answer: "${input}"`);
  await say({ blocks: [section(`<@${event.user}>`), section(r||'Error'), context('`/wavmind` for all commands')] });
});

// ─── MCP SERVER (same port via HTTP) ─────────────────────
function startMCPServer() {
  const mcpTools = [
    { name: 'search_samples', description: 'Search 500K+ free Creative Commons samples from Freesound' },
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
        if (req.url === '/health') {
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'ok', service: 'Wavmind', tools: mcpTools.map(t => t.name) }));
          return;
        }
        if (req.url === '/mcp') {
          res.writeHead(200);
          res.end(JSON.stringify({ name: 'wavmind', version: '1.0.0', description: 'AI tools for music producers', tools: mcpTools }));
          return;
        }
        if (req.url === '/mcp/tools') {
          res.writeHead(200);
          res.end(JSON.stringify({ tools: mcpTools }));
          return;
        }
        if (req.method === 'POST' && req.url === '/mcp/execute') {
          const { tool, arguments: args } = JSON.parse(body);
          let result;
          if (tool === 'search_samples') { result = await searchFreesound(args.query); }
          else if (tool === 'get_track_features') { result = await getTrackFeatures(args.track_name); }
          else if (tool === 'analyze_mix') { result = await askAI(`Mix feedback for: ${args.description}. BPM: ${args.bpm||'?'}, Key: ${args.key||'?'}.`); }
          else if (tool === 'get_daw_help') { const [tav, ai] = await Promise.all([tavilySearch(`${args.daw} ${args.question}`), askAI(`${args.daw} tutorial: "${args.question}"`)]);  result = { ai_answer: ai, web_answer: tav?.answer, sources: tav?.results }; }
          else if (tool === 'compare_artists') { const [s1,s2]=await Promise.all([getArtistStats(args.artist1),getArtistStats(args.artist2)]); result={artist1:s1,artist2:s2}; }
          else if (tool === 'get_track_ideas') { result = await askAI(`5 track ideas for "${args.genre}".`); }
          else result = { error: 'Unknown tool' };
          res.writeHead(200);
          res.end(JSON.stringify({ tool, result }));
          return;
        }
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });

  const port = process.env.MCP_PORT || 8000;
  server.listen(port, () => console.log(`🔌 MCP Server on port ${port}`));
}

// ─── START ────────────────────────────────────────────────
(async () => {
  await app.start();
  console.log('🎛️ Wavmind is running!');
  startMCPServer();
  scheduleWeeklyDigest(app.client);
})();
