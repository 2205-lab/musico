require('dotenv').config();
const { App } = require('@slack/bolt');
const Groq = require('groq-sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── GROQ AI ─────────────────────────────────────────────
async function askAI(prompt) {
  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content: 'You are Wavmind, an expert AI assistant for music producers. Format responses using Slack mrkdwn only. Use *text* for bold (single asterisk only). Use _text_ for italic. Use • for bullet points. Never use ** double asterisks, never use ### or ## or # for headers. Keep responses clean and scannable.',
        },
        { role: 'user', content: prompt }
      ],
      max_tokens: 1024,
    });
    let text = response.choices[0].message.content;
    text = text.replace(/#{1,6}\s+/g, '*');
    text = text.replace(/\*\*([^*]+)\*\*/g, '*$1*');
    text = text.replace(/^-\s+/gm, '• ');
    text = text.replace(/^\d+\.\s+/gm, '• ');
    return text;
  } catch (err) {
    console.error('Groq error:', err.message);
    return null;
  }
}

// ─── TAVILY SEARCH ────────────────────────────────────────
async function tavilySearch(query) {
  try {
    const res = await axios.post(
      'https://api.tavily.com/search',
      { api_key: process.env.TAVILY_API_KEY, query, search_depth: 'basic', max_results: 5, include_answer: true },
      { timeout: 10000 }
    );
    return {
      answer: res.data.answer || null,
      results: (res.data.results || []).map(r => ({ title: r.title, url: r.url, content: r.content?.slice(0, 300) || '' })),
    };
  } catch (err) {
    console.error('Tavily error:', err.message);
    return null;
  }
}

// ─── FREESOUND ────────────────────────────────────────────
async function searchFreesound(query) {
  try {
    const cleanQuery = query.replace(/\b(loop|loops|sample|samples|pack)\b/gi, '').replace(/\b(\d+bpm|bpm)\b/gi, '').trim().split(' ').slice(0, 3).join(' ');
    const searchQuery = encodeURIComponent(cleanQuery || query);
    const url = `https://freesound.org/apiv2/search/text/?query=${searchQuery}&token=${process.env.FREESOUND_API_KEY}&format=json&page_size=10&fields=id,name,tags,duration,license,username,previews,avg_rating,num_downloads&filter=duration:[1+TO+30]`;
    const res = await axios.get(url, { timeout: 10000 });
    const sounds = res.data.results || [];
    if (!sounds.length) return null;
    return sounds.map(s => ({
      id: s.id, name: s.name,
      duration: s.duration ? Math.round(s.duration * 10) / 10 : 0,
      license: s.license?.includes('publicdomain') ? 'CC0 — Free' : s.license?.includes('by/3.0') || s.license?.includes('by/4.0') ? 'CC Attribution' : 'Creative Commons',
      username: s.username,
      preview: s.previews?.['preview-hq-mp3'] || s.previews?.['preview-lq-mp3'] || null,
      url: `https://freesound.org/people/${s.username}/sounds/${s.id}/`,
      downloads: s.num_downloads || 0,
      rating: s.avg_rating ? Math.round(s.avg_rating * 10) / 10 : 0,
      tags: (s.tags || []).slice(0, 8).join(' · '),
    }));
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
    const modes = ['Minor','Major'];
    return { name: track.name, artist: track.artists[0].name, bpm: Math.round(features.data.tempo), key: keys[features.data.key] + ' ' + modes[features.data.mode], energy: Math.round(features.data.energy * 100), danceability: Math.round(features.data.danceability * 100), loudness: features.data.loudness.toFixed(1), valence: Math.round(features.data.valence * 100) };
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
    const avg = (key) => Math.round(features.reduce((sum, f) => sum + f[key], 0) / features.length);
    const avgFloat = (key) => (features.reduce((sum, f) => sum + f[key], 0) / features.length).toFixed(1);
    const keys = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    return { name: artistName, bpm: avg('tempo'), energy: Math.round(avg('energy')), danceability: Math.round(avg('danceability')), valence: Math.round(avg('valence')), loudness: avgFloat('loudness'), key: keys[Math.abs(avg('key')) % 12] + ' ' + ['Minor','Major'][avg('mode') > 0 ? 1 : 0] };
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
    console.error('Audio error:', err.message);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { error: err.message };
  }
}

// ─── BLOCK KIT HELPERS ───────────────────────────────────
const divider = () => ({ type: 'divider' });
const header = (text) => ({ type: 'header', text: { type: 'plain_text', text, emoji: true } });
const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });
const twoCol = (l, r) => ({ type: 'section', fields: [{ type: 'mrkdwn', text: l }, { type: 'mrkdwn', text: r }] });
const context = (text) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

// ─── COMPARISON SESSIONS ─────────────────────────────────
global.compareSessions = global.compareSessions || {};
const getCompareSession = (userId) => global.compareSessions[userId] || null;
const startCompareSession = (userId) => { global.compareSessions[userId] = { status: 'waiting_your_track', yourTrack: null, referenceTrack: null, startedAt: new Date().toISOString() }; return global.compareSessions[userId]; };
const clearCompareSession = (userId) => { delete global.compareSessions[userId]; };

// ─── COLLAB MODE ─────────────────────────────────────────
global.collabSessions = global.collabSessions || {};
const getCollabSession = (id) => global.collabSessions[id] || null;
const startCollabSession = (channelId, trackName, userId) => { global.collabSessions[channelId] = { trackName, startedBy: userId, startedAt: new Date().toISOString(), ideas: [], feedback: [], decisions: [] }; return global.collabSessions[channelId]; };
const endCollabSession = (id) => { const s = global.collabSessions[id]; delete global.collabSessions[id]; return s; };

// ─── WELCOME BLOCKS ───────────────────────────────────────
function getWelcomeBlocks() {
  return [
    header('🎛️ Wavmind — AI Producer Agent'),
    section('Everything you need to make better music, inside Slack.'),
    divider(),
    section('*🆚 Audio Comparison*\n`/wavmind mix compare start`\n_Upload your track + reference → instant gap analysis_'),
    section('*🔍 Reference Analysis*\n`/wavmind reference [track - artist]`\n_Example: `/wavmind reference Blinding Lights - The Weeknd`_'),
    section('*🎹 DAW Help*\n`/wavmind daw [daw] [question]`\n_Example: `/wavmind daw fl studio how to sidechain 808`_\n_Supports: FL Studio · Ableton · Logic · Pro Tools · Cubase · Studio One_'),
    section('*🎵 Free Samples*\n`/wavmind samples [keywords]`\n_Example: `/wavmind samples drums` · `/wavmind samples piano`_'),
    section('*🎚️ Mix Feedback*\n`/wavmind feedback [describe your mix]`\n_Or upload MP3/WAV → `/wavmind mixfeedback bpm:140 key:F_minor`_'),
    section('*🎤 Artist DNA*\n`/wavmind compare [artist1] and [artist2]`\n_Example: `/wavmind compare Drake and Travis Scott`_'),
    section('*🎯 A&R Evaluation*\n`/wavmind ar [describe your track]`\n_Example: `/wavmind ar dark trap 140bpm heavy 808s melodic piano`_'),
    section('*🤝 Collab Mode*\n`/wavmind collab start "Track Name"` · `idea` · `feedback` · `decision` · `summary` · `end`'),
    divider(),
    section('*🎛️ Production Tools*\n`/wavmind ideas [genre]` — Track concepts\n`/wavmind bpm [genre]` — BPM, key & structure\n`/wavmind chords [key + genre]` — Chord progressions\n`/wavmind tips [topic]` — Expert production tips'),
    divider(),
    context('💬 @mention Wavmind anywhere · Type `/wavmind` anytime to see this menu'),
  ];
}

// ─── APP HOME ─────────────────────────────────────────────
app.event('app_home_opened', async ({ event, client }) => {
  try {
    await client.views.publish({
      user_id: event.user,
      view: {
        type: 'home',
        blocks: [
          // Hero
          { type: 'section', text: { type: 'mrkdwn', text: '*🎛️ Wavmind*\n_Your AI music production agent inside Slack_' } },
          divider(),

          // ANALYZE section
          header('🔬 Analyze'),
          { type: 'section', fields: [
            { type: 'mrkdwn', text: '*🆚 Audio Comparison*\nUpload your track + reference → side-by-side gap analysis with AI fix recommendations\n\n`/wavmind mix compare start`' },
            { type: 'mrkdwn', text: '*🔍 Reference Analysis*\nGet real Spotify data + full production blueprint for any song\n\n`/wavmind reference [track - artist]`' },
          ]},

          divider(),

          // CREATE section
          header('🎹 Create'),
          { type: 'section', fields: [
            { type: 'mrkdwn', text: '*🎹 DAW Knowledge*\nReal-time step-by-step tutorials for any DAW powered by Tavily + AI\n\n`/wavmind daw [daw] [question]`' },
            { type: 'mrkdwn', text: '*🎵 Free Samples*\nSearch 500,000+ Creative Commons sounds from Freesound.org\n\n`/wavmind samples [keywords]`' },
          ]},
          { type: 'section', fields: [
            { type: 'mrkdwn', text: '*🎛️ Production Tools*\nTrack ideas, BPM & key suggestions, chord progressions, production tips\n\n`/wavmind ideas` · `/wavmind bpm` · `/wavmind chords` · `/wavmind tips`' },
            { type: 'mrkdwn', text: '*🎚️ Mix Feedback*\nDescribe your mix or upload audio for professional AI mixing advice\n\n`/wavmind feedback [describe mix]`' },
          ]},

          divider(),

          // DEVELOP section
          header('📈 Develop'),
          { type: 'section', fields: [
            { type: 'mrkdwn', text: '*🎤 Artist DNA*\nCompare two artists using real Spotify production data\n\n`/wavmind compare [artist1] and [artist2]`' },
            { type: 'mrkdwn', text: '*🎯 A&R Evaluation*\nGet an honest label executive assessment of your track\'s commercial potential\n\n`/wavmind ar [describe track]`' },
          ]},

          divider(),

          // COLLABORATE section
          header('🤝 Collaborate'),
          { type: 'section', text: { type: 'mrkdwn', text: '*🤝 Collab Mode* — Work on tracks with your team inside Slack\n\n`/wavmind collab start "Track Name"` — Start a session\n`/wavmind collab idea [idea]` — Log an idea\n`/wavmind collab feedback [feedback]` — Log feedback\n`/wavmind collab decision [decision]` — Log a decision\n`/wavmind collab summary` — Get AI summary\n`/wavmind collab end` — End session' } },

          divider(),

          // Audio workflow
          header('🎛️ Audio Analysis Workflow'),
          { type: 'section', text: { type: 'mrkdwn', text: '*Regular analysis:*\n• Upload MP3/WAV → Wavmind scans energy, brightness, bass\n• Then: `/wavmind mixfeedback bpm:85 key:F_minor`\n\n*Comparison mode:*\n• `/wavmind mix compare start`\n• Upload your track → upload reference\n• Get instant gap report + AI fix recommendations' } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: '💡 Key format: `C_major` · `F_minor` · `G_major` · `A_minor` · `Bb_major`' }] },

          divider(),

          // DAW examples
          header('🎹 DAW Knowledge Examples'),
          { type: 'section', text: { type: 'mrkdwn', text: '`/wavmind daw fl studio how to sidechain 808`\n`/wavmind daw ableton how to warp audio`\n`/wavmind daw logic pro how to use flex pitch`\n`/wavmind daw pro tools how to set up sessions`\n`/wavmind daw cubase how to use chord track`' } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: 'Supported: FL Studio · Ableton Live · Logic Pro · Pro Tools · Cubase · Studio One · GarageBand · Reaper · Bitwig · Reason' }] },

          divider(),

          // Powered by
          header('⚡ Powered By'),
          { type: 'section', fields: [
            { type: 'mrkdwn', text: '🤖 *Groq AI*\nLlama 3.1 — fast responses' },
            { type: 'mrkdwn', text: '🎵 *Spotify API*\nReal audio features data' },
          ]},
          { type: 'section', fields: [
            { type: 'mrkdwn', text: '🔍 *Tavily*\nReal-time DAW web search' },
            { type: 'mrkdwn', text: '🎵 *Freesound*\n500,000+ CC samples' },
          ]},
          { type: 'section', fields: [
            { type: 'mrkdwn', text: '🎧 *Librosa*\nPython audio analysis' },
            { type: 'mrkdwn', text: '📰 *NewsData*\nReal-time music news' },
          ]},

          divider(),
          { type: 'context', elements: [{ type: 'mrkdwn', text: '🎛️ *Wavmind* — Type `/wavmind` in any channel to get started' }] },
        ],
      },
    });
  } catch (err) {
    console.error('App Home error:', err.message);
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
        compareSession.channelId = channelId;
        await client.chat.postMessage({ channel: channelId, blocks: [header('🎵 Scanning Your Track...'), section(`*File:* ${file.name}`), context('⏳ Step 1 of 2')] });

        const analysis = await analyzeAudioFile(file.url_private_download, file.name);
        if (!analysis || analysis.error) {
          await client.chat.postMessage({ channel: channelId, blocks: [header('❗ Scan Failed'), section('Try MP3 format under 10MB.')] });
          return;
        }

        compareSession.yourTrack = { filename: file.name, energy: analysis.energy, brightness: analysis.brightness, bass_ratio: analysis.bass_ratio, duration: analysis.duration };
        compareSession.status = 'waiting_reference';

        const mins = Math.floor(analysis.duration / 60);
        const secs = String(analysis.duration % 60).padStart(2, '0');

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
            section('Upload the song you want to sound like.\n_Example: a track by your favorite artist_'),
            context('⏳ Step 2 of 2 · Wavmind will compare both automatically'),
          ],
        });

      } else if (compareSession.status === 'waiting_reference') {
        await client.chat.postMessage({ channel: channelId, blocks: [header('🔍 Scanning Reference Track...'), section(`*File:* ${file.name}`), context('⏳ Generating comparison report...')] });

        const analysis = await analyzeAudioFile(file.url_private_download, file.name);
        if (!analysis || analysis.error) {
          await client.chat.postMessage({ channel: channelId, blocks: [header('❗ Scan Failed'), section('Try MP3 format under 10MB.')] });
          return;
        }

        compareSession.referenceTrack = { filename: file.name, energy: analysis.energy, brightness: analysis.brightness, bass_ratio: analysis.bass_ratio, duration: analysis.duration };

        const yours = compareSession.yourTrack;
        const ref = compareSession.referenceTrack;

        const energyDiff = ref.energy - yours.energy;
        const bassDiff = ref.bass_ratio - yours.bass_ratio;
        const brightnessMap = { 'Dark (heavy low end)': 1, 'Balanced': 2, 'Bright (strong high end)': 3 };
        const brightDiff = (brightnessMap[ref.brightness] || 2) - (brightnessMap[yours.brightness] || 2);

        const yourMins = Math.floor(yours.duration / 60);
        const yourSecs = String(yours.duration % 60).padStart(2, '0');
        const refMins = Math.floor(ref.duration / 60);
        const refSecs = String(ref.duration % 60).padStart(2, '0');

        const aiAnalysis = await askAI(
          `You are Wavmind, a professional mixing engineer. Compare:

YOUR TRACK "${yours.filename}": Energy ${yours.energy}%, Brightness ${yours.brightness}, Bass ${yours.bass_ratio}%
REFERENCE "${ref.filename}": Energy ${ref.energy}%, Brightness ${ref.brightness}, Bass ${ref.bass_ratio}%

Energy gap: ${Math.abs(energyDiff)}% ${energyDiff > 0 ? '(reference more energetic)' : energyDiff < 0 ? '(your track more energetic)' : '(matched)'}
Bass gap: ${Math.abs(bassDiff)}% ${bassDiff > 0 ? '(reference more bass)' : bassDiff < 0 ? '(your track more bass)' : '(matched)'}
Brightness: ${brightDiff > 0 ? 'Reference is brighter' : brightDiff < 0 ? 'Your track is brighter' : 'Matched'}

Give specific actionable advice to close each gap. Include EQ, compression, bass treatment. Top 3 most important changes first. Use real plugin names. Format with clear sections and emojis.`
        );

        clearCompareSession(userId);

        await client.chat.postMessage({
          channel: channelId,
          blocks: [
            header('🆚 Mix Comparison Report'),
            divider(),
            twoCol(`🎵 *Your Track*\n${yours.filename}`, `🎯 *Reference*\n${ref.filename}`),
            divider(),
            section('📊 *Side-by-Side Analysis*'),
            twoCol(`⚡ *Your Energy*\n${yours.energy}%`, `⚡ *Ref Energy*\n${ref.energy}%  ${Math.abs(energyDiff) <= 5 ? '✅ Match' : energyDiff > 0 ? '⚠️ Ref higher' : '✅ You\'re higher'}`),
            twoCol(`🔊 *Your Bass*\n${yours.bass_ratio}%`, `🔊 *Ref Bass*\n${ref.bass_ratio}%  ${Math.abs(bassDiff) <= 5 ? '✅ Match' : bassDiff > 0 ? '⚠️ Ref heavier' : '✅ You\'re heavier'}`),
            twoCol(`🌈 *Your Brightness*\n${yours.brightness}`, `🌈 *Ref Brightness*\n${ref.brightness}  ${brightDiff === 0 ? '✅ Match' : '⚠️ Gap'}`),
            twoCol(`⏱️ *Your Duration*\n${yourMins}:${yourSecs}`, `⏱️ *Ref Duration*\n${refMins}:${refSecs}`),
            divider(),
            header('🤖 AI Gap Analysis & Fix Recommendations'),
            section(aiAnalysis || 'Could not generate analysis. Try again!'),
            divider(),
            section('*🎛️ Next Steps:*\n• Apply the recommended EQ and compression changes\n• Re-export your track\n• Run `/wavmind mix compare start` again to check progress'),
            context('💡 Start over: `/wavmind mix compare start` · Cancel: `/wavmind mix compare cancel`'),
          ],
        });
      }
      return;
    }

    // ─── NORMAL UPLOAD MODE ──────────────────────────────
    await client.chat.postMessage({
      channel: channelId,
      blocks: [header('🎵 Scanning Your Track...'), section(`*File:* ${file.name}`), context('⏳ Analyzing energy, brightness and bass...')],
    });

    const analysis = await analyzeAudioFile(file.url_private_download, file.name);
    if (!analysis || analysis.error) {
      await client.chat.postMessage({ channel: channelId, blocks: [header('❗ Scan Failed'), section(`Could not analyze *${file.name}*. Try MP3 under 10MB.`), context(`Error: ${analysis?.error || 'Unknown'}`)] });
      return;
    }

    global.pendingAnalysis = global.pendingAnalysis || {};
    global.pendingAnalysis[channelId] = { filename: file.name, energy: analysis.energy, brightness: analysis.brightness, bass_ratio: analysis.bass_ratio, duration: analysis.duration };

    const mins = Math.floor(analysis.duration / 60);
    const secs = String(analysis.duration % 60).padStart(2, '0');

    await client.chat.postMessage({
      channel: channelId,
      blocks: [
        header('🎛️ Scan Complete'),
        section(`*File:* ${file.name}`),
        divider(),
        twoCol(`⚡ *Energy*\n${analysis.energy}%`, `🌈 *Brightness*\n${analysis.brightness}`),
        twoCol(`🔊 *Bass*\n${analysis.bass_ratio}%`, `⏱️ *Duration*\n${mins}:${secs}`),
        divider(),
        section('*What would you like to do?*\n\n• Get mix feedback: `/wavmind mixfeedback bpm:85 key:F_minor`\n• Compare with reference: `/wavmind mix compare start`'),
        context('💡 Key format: `C_major` · `F_minor` · `G_major` · `A_minor` · `Bb_major`'),
      ],
    });
  } catch (err) { console.error('File error:', err.message); }
});

// ─── SLASH COMMANDS ───────────────────────────────────────
app.command('/wavmind', async ({ command, ack, respond }) => {
  await ack();
  const input = command.text.trim();
  const lower = input.toLowerCase();
  const userId = command.user_id;

  if (!input || lower === 'help') {
    await respond({ response_type: 'ephemeral', blocks: getWelcomeBlocks() });
    return;
  }

  // ─── MIX COMPARE ─────────────────────────────────────
  if (lower.startsWith('mix compare') || lower.startsWith('mix-compare')) {
    if (lower.includes('cancel')) {
      clearCompareSession(userId);
      await respond({ blocks: [header('🗑️ Cancelled'), section('Comparison cancelled. Start again: `/wavmind mix compare start`')] });
      return;
    }

    const existing = getCompareSession(userId);
    if (existing) {
      await respond({ blocks: [header('⚠️ Session Active'), section(`Status: ${existing.status === 'waiting_your_track' ? 'Waiting for your track' : 'Waiting for reference track'}\n\nUpload your ${existing.status === 'waiting_your_track' ? 'track' : 'reference'} or cancel: \`/wavmind mix compare cancel\``)] });
      return;
    }

    startCompareSession(userId);
    await respond({
      response_type: 'in_channel',
      blocks: [
        header('🆚 Mix Comparison Started'),
        section(`*<@${userId}>* follow these 3 steps:`),
        divider(),
        section('*Step 1 — Upload YOUR track*\nUpload the beat or song you\'re working on'),
        section('*Step 2 — Upload your REFERENCE track*\nUpload the song you want to sound like'),
        section('*Step 3 — Get your gap report*\nWavmind compares both and gives you:\n• Side-by-side energy, bass and brightness\n• Gap analysis with ✅ Match or ⚠️ warnings\n• Specific AI advice to close each gap'),
        divider(),
        context('💡 Upload your track now · Cancel: `/wavmind mix compare cancel`'),
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
          header('🎹 DAW Knowledge'),
          section('*Format:* `/wavmind daw [daw name] [question]`\n\n*Examples:*\n`/wavmind daw fl studio how to sidechain 808`\n`/wavmind daw ableton how to warp audio`\n`/wavmind daw logic pro how to use flex pitch`\n`/wavmind daw pro tools how to set up sessions`'),
          context('Supported: FL Studio · Ableton Live · Logic Pro · Pro Tools · Cubase · Studio One · GarageBand · Reaper · Bitwig · Reason'),
        ],
      });
      return;
    }

    const dawList = [
      { name: 'FL Studio', keywords: ['fl studio', 'fl', 'fruity loops'] },
      { name: 'Ableton Live', keywords: ['ableton', 'ableton live', 'live'] },
      { name: 'Logic Pro', keywords: ['logic', 'logic pro', 'logic pro x'] },
      { name: 'Pro Tools', keywords: ['pro tools', 'protools'] },
      { name: 'Cubase', keywords: ['cubase'] },
      { name: 'Studio One', keywords: ['studio one', 'studio 1'] },
      { name: 'GarageBand', keywords: ['garageband', 'garage band'] },
      { name: 'Reason', keywords: ['reason'] },
      { name: 'Bitwig', keywords: ['bitwig'] },
      { name: 'Reaper', keywords: ['reaper'] },
    ];

    let detectedDAW = null;
    let question = dawInput;

    for (const daw of dawList) {
      for (const keyword of daw.keywords) {
        if (dawInput.toLowerCase().startsWith(keyword)) {
          detectedDAW = daw.name;
          question = dawInput.slice(keyword.length).trim();
          break;
        }
      }
      if (detectedDAW) break;
    }

    if (!detectedDAW) {
      await respond({ blocks: [header('❗ DAW Not Recognized'), section(`Try: \`/wavmind daw fl studio how to sidechain\``), context('Supported: FL Studio · Ableton · Logic Pro · Pro Tools · Cubase · Studio One')] });
      return;
    }

    await respond({ blocks: [header(`🎹 ${detectedDAW}...`), section(`*Q:* ${question}`), context('⏳ Tavily search + AI answer...')] });

    const [tavilyData, aiBase] = await Promise.all([
      tavilySearch(`${detectedDAW} ${question} tutorial step by step`),
      askAI(`You are Wavmind, expert ${detectedDAW} instructor. Answer: "${question}". Give clear numbered steps with bold key terms.`),
    ]);

    const blocks = [header(`🎹 ${detectedDAW}: ${question}`), divider(), section('🤖 *AI Answer:*'), section(aiBase || 'Could not generate.')];
    if (tavilyData?.answer) blocks.push(divider(), section('🌐 *From the Web:*'), section(tavilyData.answer));
    if (tavilyData?.results?.length) blocks.push(divider(), section('📚 *Resources:*'), section(tavilyData.results.slice(0, 4).map(r => `• <${r.url}|${r.title}>`).join('\n')));
    blocks.push(divider(), context(`🎹 ${detectedDAW} · Tavily + Groq AI`));

    await respond({ blocks });
    return;
  }

  // ─── SAMPLES ─────────────────────────────────────────
  if (lower.startsWith('samples')) {
    const query = input.slice(7).trim();
    if (!query) {
      await respond({ blocks: [header('🎵 Free Samples'), section('*Examples:*\n`/wavmind samples drums`\n`/wavmind samples piano`\n`/wavmind samples bass`\n`/wavmind samples guitar`\n`/wavmind samples synth`\n`/wavmind samples ambient`'), context('All Creative Commons — free to use')] });
      return;
    }

    await respond({ blocks: [header('🎵 Searching Freesound...'), section(`*"${query}"*`), context('⏳')] });
    const sounds = await searchFreesound(query);

    if (!sounds || sounds.length === 0) {
      const simple = query.split(' ')[0];
      const retry = simple !== query ? await searchFreesound(simple) : null;
      if (retry?.length) {
        const blocks = [header(`🎵 Results for "${simple}"`), section(`_No exact results for "${query}"_`), divider()];
        retry.forEach((s, i) => { blocks.push(section(`*${i+1}. ${s.name}*\n⏱️ ${s.duration}s · ⭐ ${s.rating}/5 · 📄 ${s.license}\n👤 ${s.username}\n${s.preview ? `🔊 *<${s.preview}|▶ Listen>*  ` : ''}🔗 *<${s.url}|📥 Download>*`)); if (i < retry.length-1) blocks.push(divider()); });
        blocks.push(context('🎵 Freesound.org'));
        await respond({ blocks });
      } else {
        await respond({ blocks: [header('❗ No Results'), section(`No sounds for *"${query}"*. Try simpler: \`/wavmind samples drums\``), section(`🔗 *<https://freesound.org/search/?q=${encodeURIComponent(query)}|Browse Freesound>*`)] });
      }
      return;
    }

    const aiTip = await askAI(`Producer found "${query}" samples: ${sounds.slice(0,3).map(s=>s.name).join(', ')}. Give 2-3 production tips. Under 60 words. Bullet points.`);
    const blocks = [header(`🎵 Samples: "${query}"`), section(`*${sounds.length} sounds* — all free`), context('Click Listen to preview · Click Download for full file'), divider()];
    sounds.forEach((s, i) => { blocks.push(section(`*${i+1}. ${s.name}*\n⏱️ *${s.duration}s* · ⭐ *${s.rating}/5* · 📥 *${s.downloads.toLocaleString()}*\n📄 ${s.license} · 👤 ${s.username}\n🏷️ ${s.tags}\n\n${s.preview ? `🔊 *<${s.preview}|▶ Listen>*     ` : ''}🔗 *<${s.url}|📥 Download on Freesound>*`)); if (i < sounds.length-1) blocks.push(divider()); });
    if (aiTip) blocks.push(divider(), header('💡 Tips'), section(aiTip));
    blocks.push(divider(), section(`🔗 *<https://freesound.org/search/?q=${encodeURIComponent(query)}|Browse more on Freesound>*`), context('🎵 Creative Commons · Freesound.org'));
    await respond({ blocks });
    return;
  }

  // ─── COLLAB ──────────────────────────────────────────
  if (lower.startsWith('collab')) {
    const sub = input.slice(6).trim();
    const subL = sub.toLowerCase();

    if (subL.startsWith('start')) {
      const name = sub.slice(5).trim().replace(/['"]/g,'') || 'Untitled';
      if (getCollabSession(command.channel_id)) { await respond({ blocks: [header('⚠️ Active'), section('`/wavmind collab end` first')] }); return; }
      startCollabSession(command.channel_id, name, userId);
      await respond({ response_type: 'in_channel', blocks: [header('🤝 Collab Started'), section(`*Track:* "${name}"\n*By:* <@${userId}>`), divider(), twoCol('💡 `/wavmind collab idea [idea]`','🎚️ `/wavmind collab feedback [fb]`'), twoCol('✅ `/wavmind collab decision [dec]`','📋 `/wavmind collab summary`'), context('`/wavmind collab end` to finish')] });
      return;
    }
    if (subL.startsWith('idea')) {
      const t = sub.slice(4).trim(); const s = getCollabSession(command.channel_id);
      if (!s) { await respond({ blocks: [header('❗ No Session'), section('`/wavmind collab start "Name"`')] }); return; }
      if (!t) { await respond({ blocks: [header('❗ Missing'), section('`/wavmind collab idea [idea]`')] }); return; }
      s.ideas.push({ text: t, user: userId, time: new Date().toISOString() });
      await respond({ response_type: 'in_channel', blocks: [header('💡 Idea Logged'), section(`*"${t}"* — <@${userId}>`), context(`${s.ideas.length} ideas for "${s.trackName}"`)] });
      return;
    }
    if (subL.startsWith('feedback')) {
      const t = sub.slice(8).trim(); const s = getCollabSession(command.channel_id);
      if (!s) { await respond({ blocks: [header('❗ No Session'), section('`/wavmind collab start "Name"`')] }); return; }
      if (!t) { await respond({ blocks: [header('❗ Missing'), section('`/wavmind collab feedback [feedback]`')] }); return; }
      s.feedback.push({ text: t, user: userId, time: new Date().toISOString() });
      await respond({ response_type: 'in_channel', blocks: [header('🎚️ Feedback Logged'), section(`*"${t}"* — <@${userId}>`), context(`${s.feedback.length} feedback for "${s.trackName}"`)] });
      return;
    }
    if (subL.startsWith('decision')) {
      const t = sub.slice(8).trim(); const s = getCollabSession(command.channel_id);
      if (!s) { await respond({ blocks: [header('❗ No Session'), section('`/wavmind collab start "Name"`')] }); return; }
      if (!t) { await respond({ blocks: [header('❗ Missing'), section('`/wavmind collab decision [decision]`')] }); return; }
      s.decisions.push({ text: t, user: userId, time: new Date().toISOString() });
      await respond({ response_type: 'in_channel', blocks: [header('✅ Decision Logged'), section(`*"${t}"* — <@${userId}>`), context(`${s.decisions.length} decisions for "${s.trackName}"`)] });
      return;
    }
    if (subL.startsWith('status')) {
      const s = getCollabSession(command.channel_id);
      if (!s) { await respond({ blocks: [header('❗ No Session'), section('`/wavmind collab start "Name"`')] }); return; }
      await respond({ blocks: [header('📊 Session Status'), section(`*"${s.trackName}"* by <@${s.startedBy}>`), divider(), twoCol(`💡 Ideas: ${s.ideas.length}`,`🎚️ Feedback: ${s.feedback.length}`), twoCol(`✅ Decisions: ${s.decisions.length}`,`⏱️ ${new Date(s.startedAt).toLocaleTimeString()}`), context('`/wavmind collab summary` · `/wavmind collab end`')] });
      return;
    }
    if (subL.startsWith('summary')) {
      const s = getCollabSession(command.channel_id);
      if (!s) { await respond({ blocks: [header('❗ No Session')] }); return; }
      await respond({ blocks: [header('📋 Generating...'), context('⏳')] });
      const r = await askAI(`Summarize collab for "${s.trackName}": IDEAS: ${s.ideas.map(i=>i.text).join(', ')||'None'} FEEDBACK: ${s.feedback.map(f=>f.text).join(', ')||'None'} DECISIONS: ${s.decisions.map(d=>d.text).join(', ')||'None'}. Overview, directions, issues, next steps. Emojis.`);
      await respond({ response_type: 'in_channel', blocks: [header('📋 Summary'), section(`*"${s.trackName}"*`), divider(), twoCol(`💡 ${s.ideas.length} ideas`,`🎚️ ${s.feedback.length} feedback`), twoCol(`✅ ${s.decisions.length} decisions`,`⏱️ ${new Date(s.startedAt).toLocaleTimeString()}`), divider(), section(r||'Error'), context('`/wavmind collab end` to finish')] });
      return;
    }
    if (subL.startsWith('end')) {
      const s = getCollabSession(command.channel_id);
      if (!s) { await respond({ blocks: [header('❗ No Session')] }); return; }
      const r = await askAI(`Final report for "${s.trackName}": IDEAS: ${s.ideas.map(i=>i.text).join(', ')||'None'} FEEDBACK: ${s.feedback.map(f=>f.text).join(', ')||'None'} DECISIONS: ${s.decisions.map(d=>d.text).join(', ')||'None'}. Overview, decisions, action items, closing note.`);
      endCollabSession(command.channel_id);
      await respond({ response_type: 'in_channel', blocks: [header('🏁 Session Complete'), section(`*"${s.trackName}"*`), divider(), twoCol(`💡 ${s.ideas.length} ideas`,`🎚️ ${s.feedback.length} feedback`), divider(), section(r||'Error'), context('`/wavmind collab start "Name"` for new session')] });
      return;
    }
    await respond({ blocks: [header('🤝 Collab'), section('`start` · `idea` · `feedback` · `decision` · `summary` · `end`')] });
    return;
  }

  // ─── COMPARE ARTISTS ─────────────────────────────────
  if (lower.startsWith('compare')) {
    const artists = input.slice(7).trim();
    if (!artists || artists.split(' ').length < 2) { await respond({ blocks: [header('❗ Need Two Artists'), section('`/wavmind compare Drake and Travis Scott`')] }); return; }
    await respond({ blocks: [header('🔍 Comparing...'), context('⏳')] });
    let a1, a2;
    if (artists.toLowerCase().includes(' and ')) { [a1, a2] = artists.split(/\s+and\s+/i).map(s => s.trim()); }
    else if (artists.toLowerCase().includes(' vs ')) { [a1, a2] = artists.split(/\s+vs\s+/i).map(s => s.trim()); }
    else { const w = artists.split(' '); const m = Math.ceil(w.length/2); a1 = w.slice(0,m).join(' '); a2 = w.slice(m).join(' '); }
    const [s1, s2] = await Promise.all([getArtistStats(a1), getArtistStats(a2)]);
    if (!s1 || !s2) { await respond({ blocks: [header('❗ Not Found'), section('`/wavmind compare Drake and Travis Scott`')] }); return; }
    const ai = await askAI(`Compare: ${s1.name} (BPM ${s1.bpm}, Energy ${s1.energy}%, Dance ${s1.danceability}%, Valence ${s1.valence}%, Loud ${s1.loudness}dB, Key ${s1.key}) vs ${s2.name} (BPM ${s2.bpm}, Energy ${s2.energy}%, Dance ${s2.danceability}%, Valence ${s2.valence}%, Loud ${s2.loudness}dB, Key ${s2.key}). Key differences, unique sounds, how to blend.`);
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
        { type: 'section', fields: [{ type: 'mrkdwn', text: `🎵 Key: *${s1.key}*` }, { type: 'mrkdwn', text: `🎵 Key: *${s2.key}*` }] },
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
      const r = await askAI(`Advice on achieving sound of ${f.name} by ${f.artist}: BPM ${f.bpm}, Key ${f.key}, Energy ${f.energy}%, Dance ${f.danceability}%, Loud ${f.loudness}dB. Cover tempo, key, mixing targets, vibe. Be specific.`);
      await respond({ blocks: [header('🎵 Reference Analysis'), section(`*${f.name}* by *${f.artist}*`), divider(), twoCol(`🥁 *BPM*\n${f.bpm}`, `🎵 *Key*\n${f.key}`), twoCol(`⚡ *Energy*\n${f.energy}%`, `💃 *Dance*\n${f.danceability}%`), twoCol(`🔊 *Loudness*\n${f.loudness} dB`, `😊 *Valence*\n${f.valence}%`), divider(), section(r||'Error'), context('`/wavmind mix compare start` to compare your audio vs this reference')] });
    } else {
      const r = await askAI(`Blueprint for "${q}". Cover tempo, key, drums, bass, melody, mix approach.`);
      await respond({ blocks: [header('🎵 Reference Analysis'), section(`*${q}*`), divider(), section(r||'Error')] });
    }
    return;
  }

  // ─── FEEDBACK ────────────────────────────────────────
  if (lower.startsWith('feedback')) {
    const desc = input.slice(8).trim();
    if (!desc) { await respond({ blocks: [header('❗ Missing'), section('`/wavmind feedback My beat feels muddy at 140bpm`')] }); return; }
    await respond({ blocks: [header('🎚️ Analyzing...'), section(`_"${desc}"_`), context('⏳')] });
    const r = await askAI(`Professional mixing feedback for: "${desc}". EQ, compression, stereo width, frequency balance. Format with emojis.`);
    await respond({ blocks: [header('🎚️ Mix Feedback'), section(`_${desc}_`), divider(), section(r||'Error'), context('Upload MP3/WAV then `/wavmind mixfeedback bpm:140 key:F_minor` for deeper feedback')] });
    return;
  }

  // ─── MIXFEEDBACK ─────────────────────────────────────
  if (lower.startsWith('mixfeedback')) {
    const parts = input.slice(11).trim();
    const bpmM = parts.match(/bpm[:\s]+(\d+)/i);
    const keyM = parts.match(/key[:\s]+([\w#b_]+)/i);
    if (!bpmM || !keyM) { await respond({ blocks: [header('❗ Missing'), section('`/wavmind mixfeedback bpm:140 key:F_minor`')] }); return; }
    const bpm = parseInt(bpmM[1]); const key = keyM[1].replace(/_/g,' ');
    const stored = global.pendingAnalysis?.[command.channel_id];
    await respond({ blocks: [header('🎚️ Generating...'), twoCol(`🥁 *BPM*\n${bpm}`, `🎵 *Key*\n${key}`), context('⏳')] });
    const ctx = stored ? `Energy: ${stored.energy}%, Brightness: ${stored.brightness}, Bass: ${stored.bass_ratio}%` : '';
    const r = await askAI(`Mix feedback for BPM ${bpm}, Key ${key}. ${ctx}. EQ, compression, arrangement. Real plugin names.`);
    if (global.pendingAnalysis?.[command.channel_id]) delete global.pendingAnalysis[command.channel_id];
    await respond({ blocks: [header('🎛️ Mix Feedback'), twoCol(`🥁 *BPM*\n${bpm}`, `🎵 *Key*\n${key}`), stored ? twoCol(`⚡ *Energy*\n${stored.energy}%`, `🔊 *Bass*\n${stored.bass_ratio}%`) : divider(), divider(), section(r||'Error'), context('`/wavmind mix compare start` to compare audio files')] });
    return;
  }

  // ─── A&R ─────────────────────────────────────────────
  if (lower.startsWith('ar ') || lower === 'ar') {
    const desc = input.slice(2).trim();
    if (!desc) { await respond({ blocks: [header('❗ Missing'), section('`/wavmind ar Dark trap 140bpm heavy 808s`')] }); return; }
    await respond({ blocks: [header('🎯 A&R Evaluation...'), section(`_"${desc}"_`), context('⏳')] });
    const r = await askAI(`Senior A&R executive evaluation: "${desc}". Commercial Potential (1-10), Playlist Potential, Target Audience, Strengths, Weaknesses, Verdict (pass/consider/strong). Be honest.`);
    await respond({ blocks: [header('🎯 A&R Evaluation'), section(`_${desc}_`), divider(), section(r||'Error'), context('`/wavmind release [description]` for release readiness')] });
    return;
  }

  // ─── RELEASE ─────────────────────────────────────────
  if (lower.startsWith('release')) {
    const desc = input.slice(7).trim();
    if (!desc) { await respond({ blocks: [header('❗ Missing'), section('`/wavmind release Trap beat 140bpm mixed`')] }); return; }
    await respond({ blocks: [header('✅ Checking...'), context('⏳')] });
    const r = await askAI(`Release readiness for: "${desc}". Mix Quality, Loudness LUFS, Metadata, Distribution, Strategy, Cover art, Score X/10. Checklist with ✅ or ⚠️.`);
    await respond({ blocks: [header('✅ Release Readiness'), section(`_${desc}_`), divider(), section(r||'Error')] });
    return;
  }

  // ─── PRODUCTION TOOLS (IDEAS, BPM, CHORDS, TIPS) ────
  if (lower.startsWith('ideas')) {
    const genre = input.slice(5).trim() || 'general';
    await respond({ blocks: [header('🎵 Generating...'), context('⏳')] });
    const r = await askAI(`5 creative track ideas for "${genre}". Format: 🎵 *Title* — concept. Specific and inspiring.`);
    await respond({ blocks: [header('🎵 Track Ideas'), section(`*Genre:* ${genre}`), divider(), section(r||'Error'), context('`/wavmind bpm [genre]` · `/wavmind chords [key + genre]`')] });
    return;
  }

  if (lower.startsWith('bpm')) {
    const mood = input.slice(3).trim() || 'general';
    await respond({ blocks: [header('🥁 BPM & Key...'), context('⏳')] });
    const r = await askAI(`For "${mood}": ideal BPM range, best keys, chord progressions, song structure. Be specific with numbers.`);
    await respond({ blocks: [header('🥁 BPM & Key'), section(`*Genre:* ${mood}`), divider(), section(r||'Error'), context('`/wavmind chords [key + genre]` · `/wavmind ideas [genre]`')] });
    return;
  }

  if (lower.startsWith('chords')) {
    const q = input.slice(6).trim() || 'C minor trap';
    await respond({ blocks: [header('🎹 Chord Progressions...'), context('⏳')] });
    const r = await askAI(`3 chord progressions for "${q}". Each: chord names, Roman numerals, emotional feel, melody note.`);
    await respond({ blocks: [header('🎹 Chord Progressions'), section(`*${q}*`), divider(), section(r||'Error'), context('`/wavmind bpm [genre]` for ideal tempo')] });
    return;
  }

  if (lower.startsWith('tips')) {
    const topic = input.slice(4).trim() || 'music production';
    await respond({ blocks: [header('💡 Tips...'), context('⏳')] });
    const r = await askAI(`5 professional tips about "${topic}". Real techniques and plugin names. Emojis and bold titles.`);
    await respond({ blocks: [header('💡 Production Tips'), section(`*${topic}*`), divider(), section(r||'Error')] });
    return;
  }

  // ─── GENERAL ─────────────────────────────────────────
  await respond({ blocks: [header('🤔 Thinking...'), context('⏳')] });
  const response = await askAI(`You are Wavmind, expert AI for music producers. Answer: "${input}"`);
  await respond({ blocks: [header('🎛️ Wavmind'), section(response||'Error'), context('`/wavmind` for all commands')] });
});

// ─── MENTIONS & DMs ───────────────────────────────────────
app.event('app_mention', async ({ event, say }) => {
  const input = event.text.replace(/<@[^>]+>/g, '').trim();
  if (!input) { await say({ blocks: getWelcomeBlocks() }); return; }
  const r = await askAI(`You are Wavmind, expert AI for music producers. Answer: "${input}"`);
  await say({ blocks: [section(`<@${event.user}>`), section(r||'Error'), context('`/wavmind` for all commands')] });
});

app.message(async ({ message, say }) => {
  if (message.subtype || !message.text) return;
  const lower = message.text.toLowerCase().trim();
  if (['hi','hello','hey','start','help'].includes(lower)) { await say({ blocks: getWelcomeBlocks() }); return; }
  const r = await askAI(`You are Wavmind, expert AI for music producers. Answer: "${message.text}"`);
  await say({ blocks: [section(r||'Error'), context('`/wavmind` for all commands')] });
});

// ─── START ────────────────────────────────────────────────
(async () => {
  // Start Slack bot
  await app.start();
  console.log('🎛️ Wavmind Slack Agent is running!');

  // Start MCP server alongside
  require('./mcp-server');
})();
