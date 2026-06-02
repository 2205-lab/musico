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
      {
        api_key: process.env.TAVILY_API_KEY,
        query,
        search_depth: 'basic',
        max_results: 5,
        include_answer: true,
      },
      { timeout: 10000 }
    );
    return {
      answer: res.data.answer || null,
      results: (res.data.results || []).map(r => ({
        title: r.title,
        url: r.url,
        content: r.content?.slice(0, 300) || '',
      })),
    };
  } catch (err) {
    console.error('Tavily error:', err.message);
    return null;
  }
}

// ─── FREESOUND ────────────────────────────────────────────
async function searchFreesound(query) {
  try {
    const cleanQuery = query
      .replace(/\b(loop|loops|sample|samples|pack)\b/gi, '')
      .replace(/\b(\d+bpm|bpm)\b/gi, '')
      .trim()
      .split(' ')
      .slice(0, 3)
      .join(' ');

    const searchQuery = encodeURIComponent(cleanQuery || query);
    const url = `https://freesound.org/apiv2/search/text/?query=${searchQuery}&token=${process.env.FREESOUND_API_KEY}&format=json&page_size=10&fields=id,name,tags,duration,license,username,previews,avg_rating,num_downloads&filter=duration:[1+TO+30]`;
    const res = await axios.get(url, { timeout: 10000 });
    const sounds = res.data.results || [];
    if (!sounds.length) return null;
    return sounds.map(s => ({
      id: s.id,
      name: s.name,
      duration: s.duration ? Math.round(s.duration * 10) / 10 : 0,
      license: s.license?.includes('publicdomain') ? 'CC0 — No attribution needed' :
               s.license?.includes('by/3.0') || s.license?.includes('by/4.0') ? 'CC Attribution — Credit required' :
               'Creative Commons',
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
  const res = await axios.post(
    'https://accounts.spotify.com/api/token',
    'grant_type=client_credentials',
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(
          process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET
        ).toString('base64'),
      },
    }
  );
  return res.data.access_token;
}

async function getTrackFeatures(trackName) {
  try {
    const token = await getSpotifyToken();
    const search = await axios.get('https://api.spotify.com/v1/search', {
      headers: { Authorization: `Bearer ${token}` },
      params: { q: trackName, type: 'track', limit: 1 },
    });
    const track = search.data.tracks.items[0];
    if (!track) return null;
    const features = await axios.get(
      `https://api.spotify.com/v1/audio-features/${track.id}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const keys = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    const modes = ['Minor','Major'];
    return {
      name: track.name,
      artist: track.artists[0].name,
      bpm: Math.round(features.data.tempo),
      key: keys[features.data.key] + ' ' + modes[features.data.mode],
      energy: Math.round(features.data.energy * 100),
      danceability: Math.round(features.data.danceability * 100),
      loudness: features.data.loudness.toFixed(1),
      valence: Math.round(features.data.valence * 100),
    };
  } catch (err) {
    console.error('Spotify error:', err.message);
    return null;
  }
}

async function getArtistStats(artistName) {
  try {
    const token = await getSpotifyToken();
    const search = await axios.get('https://api.spotify.com/v1/search', {
      headers: { Authorization: `Bearer ${token}` },
      params: { q: artistName, type: 'track', limit: 5 },
    });
    const tracks = search.data.tracks.items;
    if (!tracks.length) return null;
    const featuresRes = await Promise.all(tracks.map(t =>
      axios.get(`https://api.spotify.com/v1/audio-features/${t.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ));
    const features = featuresRes.map(r => r.data);
    const avg = (key) => Math.round(features.reduce((sum, f) => sum + f[key], 0) / features.length);
    const avgFloat = (key) => (features.reduce((sum, f) => sum + f[key], 0) / features.length).toFixed(1);
    const keys = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    const modes = ['Minor','Major'];
    return {
      name: artistName,
      bpm: avg('tempo'),
      energy: Math.round(avg('energy')),
      danceability: Math.round(avg('danceability')),
      valence: Math.round(avg('valence')),
      loudness: avgFloat('loudness'),
      key: keys[Math.abs(avg('key')) % 12] + ' ' + modes[avg('mode') > 0 ? 1 : 0],
    };
  } catch (err) {
    console.error('Artist stats error:', err.message);
    return null;
  }
}

// ─── NEWSDATA ─────────────────────────────────────────────
async function getTrendingMusic(topic = 'music production') {
  try {
    const url = `https://newsdata.io/api/1/news?apikey=${process.env.NEWSDATA_API_KEY}&q=${encodeURIComponent(topic + ' music producer DAW plugin')}&language=en&category=entertainment,technology`;
    const res = await axios.get(url, { timeout: 10000 });
    const articles = res.data.results?.slice(0, 5) || [];
    if (!articles.length) return null;
    return articles.map(a => ({
      title: a.title,
      source: a.source_id,
      date: a.pubDate?.split(' ')[0] || 'recent',
      description: a.description?.slice(0, 150) || '',
    }));
  } catch (err) {
    console.error('NewsData error:', err.message);
    return null;
  }
}

// ─── AUDIO ANALYSIS ──────────────────────────────────────
async function analyzeAudioFile(fileUrl, filename) {
  const tmpDir = '/tmp';
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = path.join(tmpDir, safeName);
  try {
    const response = await axios.get(fileUrl, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      responseType: 'arraybuffer',
      timeout: 30000,
    });
    fs.writeFileSync(filePath, response.data);
    const result = execSync(`python3 analyze.py "${filePath}"`, { timeout: 60000 }).toString().trim();
    const analysis = JSON.parse(result);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return analysis;
  } catch (err) {
    console.error('Audio analysis error:', err.message);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { error: err.message };
  }
}

// ─── BLOCK KIT HELPERS ───────────────────────────────────
function divider() { return { type: 'divider' }; }
function header(text) { return { type: 'header', text: { type: 'plain_text', text, emoji: true } }; }
function section(text) { return { type: 'section', text: { type: 'mrkdwn', text } }; }
function twoCol(left, right) { return { type: 'section', fields: [{ type: 'mrkdwn', text: left }, { type: 'mrkdwn', text: right }] }; }
function context(text) { return { type: 'context', elements: [{ type: 'mrkdwn', text }] }; }

// ─── COLLAB MODE ─────────────────────────────────────────
global.collabSessions = global.collabSessions || {};
function getCollabSession(channelId) { return global.collabSessions[channelId] || null; }
function startCollabSession(channelId, trackName, userId) {
  global.collabSessions[channelId] = { trackName, startedBy: userId, startedAt: new Date().toISOString(), ideas: [], feedback: [], decisions: [] };
  return global.collabSessions[channelId];
}
function endCollabSession(id) { const s = global.collabSessions[id]; delete global.collabSessions[id]; return s; }

// ─── WELCOME BLOCKS ───────────────────────────────────────
function getWelcomeBlocks() {
  return [
    header('🎛️ Welcome to Wavmind'),
    section('*Your AI assistant for music production.* Here\'s everything I can do:'),
    divider(),
    section('*🎵 Track Ideas*\n`/wavmind ideas [genre/mood]`\n_Example: `/wavmind ideas dark trap beat`_'),
    section('*🎚️ Mixing Feedback*\n`/wavmind feedback [describe your mix]`\n_Example: `/wavmind feedback my beat feels muddy at 140bpm`_'),
    section('*🔍 Reference Track Analysis*\n`/wavmind reference [track - artist]`\n_Pulls real Spotify data and gives you a sound blueprint_\n_Example: `/wavmind reference Blinding Lights - The Weeknd`_'),
    section('*🎤 Artist Comparison*\n`/wavmind compare [artist1] and [artist2]`\n_Compare production styles using real Spotify data_\n_Example: `/wavmind compare Drake and Travis Scott`_'),
    section('*🎹 DAW Knowledge*\n`/wavmind daw [daw name] [question]`\n_Real-time tutorials powered by Tavily + Groq AI_\n_Example: `/wavmind daw fl studio how to sidechain 808`_\n_Supported: FL Studio · Ableton Live · Logic Pro · Pro Tools · Cubase · Studio One_'),
    section('*🎵 Free Samples*\n`/wavmind samples [keywords]`\n_Search 500,000+ free Creative Commons samples_\n_Example: `/wavmind samples drums` · `/wavmind samples piano` · `/wavmind samples bass`_'),
    section('*📰 Trending News*\n`/wavmind trending [topic]`\n_Real-time music industry news and AI insights_\n_Example: `/wavmind trending plugins`_'),
    section('*🥁 BPM & Key Suggestions*\n`/wavmind bpm [mood or genre]`\n_Example: `/wavmind bpm dark cinematic hip hop`_'),
    section('*🎹 Chord Progressions*\n`/wavmind chords [key + genre]`\n_Example: `/wavmind chords F minor trap`_'),
    section('*💡 Production Tips*\n`/wavmind tips [topic]`\n_Example: `/wavmind tips 808 mixing`_'),
    section('*🎯 A&R Simulation*\n`/wavmind ar [describe your track]`\n_Label executive evaluation of commercial potential_\n_Example: `/wavmind ar dark trap 140bpm heavy 808s`_'),
    section('*✅ Release Readiness*\n`/wavmind release [describe your track]`\n_Pre-release checklist for mix, metadata and distribution_'),
    section('*💰 Beat Marketplace*\n`/wavmind marketplace [genre + BPM + key]`\n_BeatStars tags, SEO titles, YouTube descriptions_'),
    section('*🤝 Collab Mode*\n`/wavmind collab start "Track Name"` — Start a session\n`/wavmind collab idea [idea]` — Log an idea\n`/wavmind collab feedback [feedback]` — Log feedback\n`/wavmind collab decision [decision]` — Log a decision\n`/wavmind collab summary` — Get AI summary\n`/wavmind collab end` — End session'),
    divider(),
    section('*🎛️ Audio File Analysis + Mix Feedback*\n*Step 1:* Upload any MP3 or WAV file directly in Slack\n*Step 2:* Wavmind scans energy, brightness and bass\n*Step 3:* Tell me your BPM and Key from your DAW\n*Step 4:* Get professional AI mixing feedback\n\n`/wavmind mixfeedback bpm:85 key:F_minor`\n_Key format: `C_major` · `F_minor` · `G_major` · `A_minor` · `Bb_major`_'),
    divider(),
    context('💬 Or just @mention me and ask anything about music production!'),
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
          { type: 'section', text: { type: 'mrkdwn', text: '*🎛️ Wavmind*\n_AI Assistant for Music Producers_' } },
          divider(),
          { type: 'section', text: { type: 'mrkdwn', text: '🎵 *What can Wavmind do for you?*' } },
          { type: 'section', fields: [{ type: 'mrkdwn', text: '🎵 *Track Ideas*\nGenerate creative track concepts for any genre or mood' }, { type: 'mrkdwn', text: '🎚️ *Mix Feedback*\nGet professional mixing advice for your beats' }] },
          { type: 'section', fields: [{ type: 'mrkdwn', text: '🔍 *Reference Tracks*\nPull real Spotify data and get a full sound blueprint' }, { type: 'mrkdwn', text: '🎤 *Artist Comparison*\nCompare two artists production styles with Spotify data' }] },
          { type: 'section', fields: [{ type: 'mrkdwn', text: '🎹 *DAW Knowledge*\nReal-time tutorials for FL Studio, Ableton, Logic and more' }, { type: 'mrkdwn', text: '🎵 *Free Samples*\nSearch 500,000+ Creative Commons samples via Freesound' }] },
          { type: 'section', fields: [{ type: 'mrkdwn', text: '📰 *Trending News*\nReal-time music industry news with AI insights' }, { type: 'mrkdwn', text: '🎹 *Chord Progressions*\nMusic theory-based chord ideas for any key and genre' }] },
          { type: 'section', fields: [{ type: 'mrkdwn', text: '🥁 *BPM & Key*\nIdeal tempo and key suggestions for any mood' }, { type: 'mrkdwn', text: '💡 *Production Tips*\nExpert tips on any music production topic' }] },
          { type: 'section', fields: [{ type: 'mrkdwn', text: '🎛️ *Audio Analysis*\nUpload MP3/WAV — Wavmind scans energy, brightness and bass' }, { type: 'mrkdwn', text: '🎯 *A&R Simulation*\nLabel exec evaluation of your track\'s commercial potential' }] },
          { type: 'section', fields: [{ type: 'mrkdwn', text: '✅ *Release Readiness*\nPre-release checklist for mix, metadata and distribution' }, { type: 'mrkdwn', text: '💰 *Beat Marketplace*\nBeatStars SEO, tags and monetization strategy' }] },
          { type: 'section', fields: [{ type: 'mrkdwn', text: '🤝 *Collab Mode*\nTeam session tracking with AI summaries' }, { type: 'mrkdwn', text: '🎵 *Mix Feedback*\nUpload audio + provide BPM/key for deep analysis' }] },
          divider(),
          { type: 'header', text: { type: 'plain_text', text: '🎹 DAW Knowledge Base', emoji: true } },
          { type: 'section', text: { type: 'mrkdwn', text: 'Get real-time step-by-step tutorials for any DAW — powered by Tavily web search + Groq AI:\n\n`/wavmind daw fl studio how to sidechain 808`\n`/wavmind daw ableton how to warp audio`\n`/wavmind daw logic pro how to use flex pitch`\n`/wavmind daw pro tools how to set up sessions`\n`/wavmind daw cubase how to use chord track`\n`/wavmind daw studio one how to use scratch pad`\n\n*Supported DAWs:*\nFL Studio · Ableton Live · Logic Pro · Pro Tools · Cubase · Studio One · GarageBand · Reason · Bitwig' } },
          divider(),
          { type: 'header', text: { type: 'plain_text', text: '🚀 Quick Start', emoji: true } },
          { type: 'section', text: { type: 'mrkdwn', text: '`/wavmind ideas dark trap beat`\n`/wavmind reference Blinding Lights - The Weeknd`\n`/wavmind compare Drake and Travis Scott`\n`/wavmind daw fl studio how to sidechain 808`\n`/wavmind samples drums`\n`/wavmind samples piano`\n`/wavmind trending plugins`\n`/wavmind bpm dark cinematic hip hop`\n`/wavmind chords F minor trap`\n`/wavmind tips 808 mixing`\n`/wavmind feedback my beat feels muddy at 140bpm`\n`/wavmind ar dark trap 140bpm heavy 808s`\n`/wavmind marketplace dark trap 140bpm F minor`' } },
          divider(),
          { type: 'header', text: { type: 'plain_text', text: '🎵 Free Sample Search', emoji: true } },
          { type: 'section', text: { type: 'mrkdwn', text: 'Search 500,000+ free Creative Commons samples:\n\n`/wavmind samples drums`\n`/wavmind samples piano`\n`/wavmind samples bass`\n`/wavmind samples guitar`\n`/wavmind samples synth`\n`/wavmind samples strings`\n`/wavmind samples vinyl`\n`/wavmind samples ambient`\n\n_All sounds are Creative Commons — free to use in your music_' } },
          divider(),
          { type: 'header', text: { type: 'plain_text', text: '🤝 Collab Mode', emoji: true } },
          { type: 'section', text: { type: 'mrkdwn', text: '`/wavmind collab start "Track Name"` — Start a session\n`/wavmind collab idea [idea]` — Log a production idea\n`/wavmind collab feedback [feedback]` — Log mix feedback\n`/wavmind collab decision [decision]` — Log a final decision\n`/wavmind collab summary` — Get full AI session summary\n`/wavmind collab end` — End and archive the session' } },
          divider(),
          { type: 'header', text: { type: 'plain_text', text: '🎛️ Audio Analysis Workflow', emoji: true } },
          { type: 'section', text: { type: 'mrkdwn', text: '*Step 1* — Upload any MP3 or WAV file in any channel\n*Step 2* — Wavmind scans energy, brightness, bass and duration\n*Step 3* — You provide your BPM and Key from your DAW\n*Step 4* — Wavmind gives you professional AI mixing feedback\n\n`/wavmind mixfeedback bpm:85 key:F_minor`' } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: '💡 Key format: `C_major` · `F_minor` · `G_major` · `A_minor` · `Bb_major` · `D_major` · `E_minor`' }] },
          divider(),
          { type: 'header', text: { type: 'plain_text', text: '📊 About Wavmind', emoji: true } },
          { type: 'section', fields: [{ type: 'mrkdwn', text: '🤖 *AI Engine*\nGroq — Llama 3.1' }, { type: 'mrkdwn', text: '🎵 *Music Data*\nReal Spotify API' }] },
          { type: 'section', fields: [{ type: 'mrkdwn', text: '🔍 *DAW Search*\nTavily Real-Time Web Search' }, { type: 'mrkdwn', text: '📰 *News*\nNewsData.io Real-Time API' }] },
          { type: 'section', fields: [{ type: 'mrkdwn', text: '🎵 *Free Samples*\nFreesound.org — 500K+ sounds' }, { type: 'mrkdwn', text: '🎧 *Audio Analysis*\nLibrosa Python' }] },
          divider(),
          { type: 'context', elements: [{ type: 'mrkdwn', text: '🎛️ *Wavmind* — Built for music producers | Type `/wavmind` in any channel to get started' }] },
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
    const audioTypes = ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg'];
    const ext = file.name.split('.').pop().toLowerCase();
    if (!audioTypes.includes(ext)) return;

    await client.chat.postMessage({
      channel: event.channel_id,
      blocks: [
        header('🎵 Scanning Your Track...'),
        section(`*File:* ${file.name}\nRunning energy, brightness and bass analysis. Takes about 15 seconds...`),
        context('⏳ Please wait'),
      ],
    });

    const analysis = await analyzeAudioFile(file.url_private_download, file.name);

    if (!analysis || analysis.error) {
      await client.chat.postMessage({
        channel: event.channel_id,
        blocks: [
          header('❗ Scan Failed'),
          section(`Could not analyze *${file.name}*.\n\nTry uploading a smaller file (under 10MB) or use MP3 format.`),
          context(`Error: ${analysis?.error || 'Unknown error'}`),
        ],
      });
      return;
    }

    global.pendingAnalysis = global.pendingAnalysis || {};
    global.pendingAnalysis[event.channel_id] = {
      filename: file.name,
      energy: analysis.energy,
      brightness: analysis.brightness,
      bass_ratio: analysis.bass_ratio,
      duration: analysis.duration,
    };

    const mins = Math.floor(analysis.duration / 60);
    const secs = String(analysis.duration % 60).padStart(2, '0');

    await client.chat.postMessage({
      channel: event.channel_id,
      blocks: [
        header('🎛️ Scan Complete'),
        section(`*File:* ${file.name}`),
        divider(),
        twoCol(`⚡ *Energy*\n${analysis.energy}%`, `🌈 *Brightness*\n${analysis.brightness}`),
        twoCol(`🔊 *Bass Presence*\n${analysis.bass_ratio}%`, `⏱️ *Duration*\n${mins}:${secs}`),
        divider(),
        section('*🎵 Ready for AI mixing feedback?*\n\nTell me your BPM and Key from your DAW:'),
        section('```/wavmind mixfeedback bpm:85 key:F_minor```'),
        section('*Key format examples:*\n`C_major` · `F_minor` · `G_major` · `A_minor` · `Bb_major` · `D_major` · `E_minor`'),
        context('💡 Find your BPM and Key in FL Studio, Ableton, Logic or any DAW'),
      ],
    });
  } catch (err) {
    console.error('File handler error:', err.message);
  }
});

// ─── SLASH COMMANDS ───────────────────────────────────────
app.command('/wavmind', async ({ command, ack, respond }) => {
  await ack();
  const input = command.text.trim();
  const lower = input.toLowerCase();

  if (!input || lower === 'help') {
    await respond({ response_type: 'ephemeral', blocks: getWelcomeBlocks() });
    return;
  }

  // ─── DAW KNOWLEDGE ───────────────────────────────────
  if (lower.startsWith('daw')) {
    const dawInput = input.slice(3).trim();

    if (!dawInput) {
      await respond({
        blocks: [
          header('🎹 DAW Knowledge Base'),
          section('Get real-time step-by-step tutorials for any DAW.\n\n*Format:*\n`/wavmind daw [daw name] [your question]`\n\n*Examples:*\n`/wavmind daw fl studio how to sidechain 808`\n`/wavmind daw ableton how to warp audio`\n`/wavmind daw logic pro how to use flex pitch`\n`/wavmind daw pro tools how to set up sessions`\n`/wavmind daw cubase how to use chord track`\n`/wavmind daw studio one how to use scratch pad`'),
          divider(),
          section('*Supported DAWs:*\nFL Studio · Ableton Live · Logic Pro · Pro Tools · Cubase · Studio One · GarageBand · Reason · Bitwig · Reaper'),
          context('💡 Powered by Tavily real-time search + Groq AI for the most accurate answers'),
        ],
      });
      return;
    }

    // Detect which DAW
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
      await respond({
        blocks: [
          header('❗ DAW Not Recognized'),
          section(`Could not detect which DAW you mean from: *"${dawInput}"*\n\n*Format:* \`/wavmind daw [daw name] [question]\`\n\n*Example:*\n\`/wavmind daw fl studio how to sidechain 808\`\n\`/wavmind daw ableton how to warp audio\``),
          context('Supported: FL Studio · Ableton Live · Logic Pro · Pro Tools · Cubase · Studio One · GarageBand · Reason · Bitwig · Reaper'),
        ],
      });
      return;
    }

    if (!question) {
      await respond({
        blocks: [
          header(`🎹 ${detectedDAW} Help`),
          section(`What do you need help with in *${detectedDAW}*?\n\n*Example:*\n\`/wavmind daw ${detectedDAW.toLowerCase()} how to sidechain\`\n\`/wavmind daw ${detectedDAW.toLowerCase()} how to export stems\`\n\`/wavmind daw ${detectedDAW.toLowerCase()} how to set up audio interface\``),
        ],
      });
      return;
    }

    await respond({
      blocks: [
        header(`🎹 ${detectedDAW} — Looking Up...`),
        section(`*Question:* ${question}`),
        context('⏳ Searching web + generating AI answer...'),
      ],
    });

    // Run Tavily search and Groq AI in parallel
    const searchQuery = `${detectedDAW} ${question} tutorial step by step`;
    const [tavilyData, aiBase] = await Promise.all([
      tavilySearch(searchQuery),
      askAI(`You are Wavmind, an expert ${detectedDAW} instructor. Answer this question about ${detectedDAW}: "${question}". Give a clear step-by-step answer based on your training knowledge. Format with numbered steps and bold key terms.`),
    ]);

    // Build combined response
    const blocks = [
      header(`🎹 ${detectedDAW}: ${question}`),
      divider(),
    ];

    // Add Groq AI answer first
    if (aiBase) {
      blocks.push(
        section('🤖 *AI Answer:*'),
        section(aiBase),
      );
    }

    // Add Tavily web results
    if (tavilyData) {
      blocks.push(divider());

      // If Tavily has a direct answer, show it
      if (tavilyData.answer) {
        blocks.push(
          section('🌐 *From the Web:*'),
          section(tavilyData.answer),
        );
      }

      // Show top sources as links
      if (tavilyData.results && tavilyData.results.length > 0) {
        blocks.push(divider());
        blocks.push(section('📚 *Helpful Resources:*'));

        const sourceLinks = tavilyData.results
          .slice(0, 4)
          .map(r => `• <${r.url}|${r.title}>`)
          .join('\n');

        blocks.push(section(sourceLinks));
      }
    }

    blocks.push(
      divider(),
      context(`🎹 ${detectedDAW} · Powered by Tavily web search + Groq AI · Try \`/wavmind daw ${detectedDAW.toLowerCase()} [another question]\``)
    );

    await respond({ blocks });
    return;
  }

  // ─── SAMPLES ─────────────────────────────────────────
  if (lower.startsWith('samples')) {
    const query = input.slice(7).trim();
    if (!query) {
      await respond({
        blocks: [
          header('🎵 Free Sample Search'),
          section('Search 500,000+ free Creative Commons samples from Freesound.org.\n\n*Examples:*\n`/wavmind samples drums`\n`/wavmind samples piano`\n`/wavmind samples bass`\n`/wavmind samples guitar`\n`/wavmind samples synth`\n`/wavmind samples strings`\n`/wavmind samples vinyl`\n`/wavmind samples ambient`'),
          divider(),
          section('💡 *Tips for best results:*\n• Use simple keywords: `drums` not `dark trap drums 140bpm loop`\n• Try instrument names: `piano`, `guitar`, `bass`, `synth`\n• Try style tags: `trap`, `lofi`, `jazz`, `ambient`'),
          context('All sounds are Creative Commons — free to use in your music'),
        ],
      });
      return;
    }

    await respond({
      blocks: [
        header('🎵 Searching Freesound.org...'),
        section(`Searching for *"${query}"* samples`),
        context('⏳ Finding free Creative Commons sounds...'),
      ],
    });

    const sounds = await searchFreesound(query);

    if (!sounds || sounds.length === 0) {
      const simpleQuery = query.split(' ')[0];
      const retrySounds = simpleQuery !== query ? await searchFreesound(simpleQuery) : null;

      if (retrySounds && retrySounds.length > 0) {
        const soundBlocks = [
          header(`🎵 Samples for "${simpleQuery}"`),
          section(`_No exact results for "${query}" — showing results for "${simpleQuery}"_`),
          divider(),
        ];
        retrySounds.forEach((sound, i) => {
          soundBlocks.push(
            section(
              `*${i + 1}. ${sound.name}*\n` +
              `⏱️ *${sound.duration}s* · ⭐ *${sound.rating}/5* · 📥 *${sound.downloads.toLocaleString()} downloads*\n` +
              `📄 *License:* ${sound.license}\n` +
              `🏷️ ${sound.tags}\n` +
              `👤 By *${sound.username}*\n\n` +
              `${sound.preview ? `🔊 *<${sound.preview}|▶ Listen to Preview>*\n` : ''}` +
              `🔗 *<${sound.url}|📥 View & Download on Freesound>*`
            )
          );
          if (i < retrySounds.length - 1) soundBlocks.push(divider());
        });
        soundBlocks.push(divider(), context('🎵 Powered by Freesound.org · Try simpler keywords for more results'));
        await respond({ blocks: soundBlocks });
      } else {
        await respond({
          blocks: [
            header('❗ No Samples Found'),
            section(`No sounds found for *"${query}"*.\n\n*Try simpler keywords:*\n• \`/wavmind samples drums\` instead of "dark trap drums 140bpm"\n• \`/wavmind samples piano\` instead of "lo-fi piano loop"\n• \`/wavmind samples bass\` instead of "808 bass loop"`),
            divider(),
            section(`🔗 *<https://freesound.org/search/?q=${encodeURIComponent(query)}|Browse "${query}" on Freesound.org>*`),
            context('Freesound has 500,000+ free Creative Commons sounds'),
          ],
        });
      }
      return;
    }

    const aiTip = await askAI(
      `You are Wavmind. A producer searched for "${query}" samples and found: ${sounds.slice(0, 3).map(s => s.name).join(', ')}. Give 2-3 specific tips on how to use these in music production. Under 80 words. Format with • bullet points.`
    );

    const soundBlocks = [
      header(`🎵 Free Samples: "${query}"`),
      section(`Found *${sounds.length} sounds* on Freesound.org — all free to use`),
      context('💡 Click Listen to preview · Click Download to get the full file on Freesound'),
      divider(),
    ];

    sounds.forEach((sound, i) => {
      soundBlocks.push(
        section(
          `*${i + 1}. ${sound.name}*\n` +
          `⏱️ *Duration:* ${sound.duration}s · ` +
          `⭐ *Rating:* ${sound.rating}/5 · ` +
          `📥 *Downloads:* ${sound.downloads.toLocaleString()}\n` +
          `📄 *License:* ${sound.license}\n` +
          `🏷️ *Tags:* ${sound.tags}\n` +
          `👤 *By:* ${sound.username}\n\n` +
          `${sound.preview ? `🔊 *<${sound.preview}|▶ Listen to Preview>*     ` : ''}` +
          `🔗 *<${sound.url}|📥 View & Download on Freesound>*`
        )
      );
      if (i < sounds.length - 1) soundBlocks.push(divider());
    });

    if (aiTip) {
      soundBlocks.push(
        divider(),
        header('💡 Production Tips'),
        section(aiTip),
      );
    }

    soundBlocks.push(
      divider(),
      section(`🔗 *<https://freesound.org/search/?q=${encodeURIComponent(query)}|Browse more "${query}" sounds on Freesound.org>*`),
      context('🎵 All sounds Creative Commons licensed · Powered by Freesound.org')
    );

    await respond({ blocks: soundBlocks });
    return;
  }

  // ─── COLLAB ──────────────────────────────────────────
  if (lower.startsWith('collab')) {
    const subInput = input.slice(6).trim();
    const subLower = subInput.toLowerCase();

    if (subLower.startsWith('start')) {
      const trackName = subInput.slice(5).trim().replace(/['"]/g, '') || 'Untitled Track';
      const existing = getCollabSession(command.channel_id);
      if (existing) {
        await respond({
          blocks: [
            header('⚠️ Session Already Active'),
            section(`A collab session for *"${existing.trackName}"* is already running.\n\nUse \`/wavmind collab summary\` to see progress or \`/wavmind collab end\` to end it.`),
          ],
        });
        return;
      }
      startCollabSession(command.channel_id, trackName, command.user_id);
      await respond({
        response_type: 'in_channel',
        blocks: [
          header('🤝 Collab Session Started'),
          section(`*Track:* "${trackName}"\n*Started by:* <@${command.user_id}>`),
          divider(),
          section('*Wavmind is now tracking this session.*\n\nLog your work as you go:'),
          twoCol('💡 *Log an idea*\n`/wavmind collab idea [idea]`', '🎚️ *Log feedback*\n`/wavmind collab feedback [feedback]`'),
          twoCol('✅ *Log a decision*\n`/wavmind collab decision [decision]`', '📋 *Get summary*\n`/wavmind collab summary`'),
          divider(),
          context(`🤝 Session active for "${trackName}" · Use /wavmind collab end to finish`),
        ],
      });
      return;
    }

    if (subLower.startsWith('idea')) {
      const idea = subInput.slice(4).trim();
      const session = getCollabSession(command.channel_id);
      if (!session) { await respond({ blocks: [header('❗ No Active Session'), section('Start first:\n`/wavmind collab start "Track Name"`')] }); return; }
      if (!idea) { await respond({ blocks: [header('❗ Missing Idea'), section('*Example:*\n`/wavmind collab idea use sidechain compression on the 808`')] }); return; }
      session.ideas.push({ text: idea, user: command.user_id, time: new Date().toISOString() });
      await respond({
        response_type: 'in_channel',
        blocks: [
          header('💡 Idea Logged'),
          section(`*"${idea}"*\n— <@${command.user_id}>`),
          context(`💡 ${session.ideas.length} idea${session.ideas.length !== 1 ? 's' : ''} logged for "${session.trackName}"`),
        ],
      });
      return;
    }

    if (subLower.startsWith('feedback')) {
      const feedbackText = subInput.slice(8).trim();
      const session = getCollabSession(command.channel_id);
      if (!session) { await respond({ blocks: [header('❗ No Active Session'), section('Start first:\n`/wavmind collab start "Track Name"`')] }); return; }
      if (!feedbackText) { await respond({ blocks: [header('❗ Missing Feedback'), section('*Example:*\n`/wavmind collab feedback the drop feels weak`')] }); return; }
      session.feedback.push({ text: feedbackText, user: command.user_id, time: new Date().toISOString() });
      await respond({
        response_type: 'in_channel',
        blocks: [
          header('🎚️ Feedback Logged'),
          section(`*"${feedbackText}"*\n— <@${command.user_id}>`),
          context(`🎚️ ${session.feedback.length} feedback item${session.feedback.length !== 1 ? 's' : ''} logged for "${session.trackName}"`),
        ],
      });
      return;
    }

    if (subLower.startsWith('decision')) {
      const decision = subInput.slice(8).trim();
      const session = getCollabSession(command.channel_id);
      if (!session) { await respond({ blocks: [header('❗ No Active Session'), section('Start first:\n`/wavmind collab start "Track Name"`')] }); return; }
      if (!decision) { await respond({ blocks: [header('❗ Missing Decision'), section('*Example:*\n`/wavmind collab decision going with F minor key`')] }); return; }
      session.decisions.push({ text: decision, user: command.user_id, time: new Date().toISOString() });
      await respond({
        response_type: 'in_channel',
        blocks: [
          header('✅ Decision Logged'),
          section(`*"${decision}"*\n— <@${command.user_id}>`),
          context(`✅ ${session.decisions.length} decision${session.decisions.length !== 1 ? 's' : ''} logged for "${session.trackName}"`),
        ],
      });
      return;
    }

    if (subLower.startsWith('status')) {
      const session = getCollabSession(command.channel_id);
      if (!session) { await respond({ blocks: [header('❗ No Active Session'), section('`/wavmind collab start "Track Name"`')] }); return; }
      await respond({
        blocks: [
          header('📊 Session Status'),
          section(`*Track:* "${session.trackName}"\n*Started by:* <@${session.startedBy}>`),
          divider(),
          twoCol(`💡 *Ideas*\n${session.ideas.length} logged`, `🎚️ *Feedback*\n${session.feedback.length} logged`),
          twoCol(`✅ *Decisions*\n${session.decisions.length} logged`, `⏱️ *Started*\n${new Date(session.startedAt).toLocaleTimeString()}`),
          divider(),
          context('Use `/wavmind collab summary` for full AI summary · `/wavmind collab end` to finish'),
        ],
      });
      return;
    }

    if (subLower.startsWith('summary')) {
      const session = getCollabSession(command.channel_id);
      if (!session) { await respond({ blocks: [header('❗ No Active Session'), section('`/wavmind collab start "Track Name"`')] }); return; }
      await respond({ blocks: [header('📋 Generating Session Summary...'), section(`Analyzing everything logged for *"${session.trackName}"*`), context('⏳ AI is reviewing your session...')] });
      const ideasText = session.ideas.length > 0 ? session.ideas.map((i, n) => `${n + 1}. ${i.text}`).join('\n') : 'None logged';
      const feedbackText = session.feedback.length > 0 ? session.feedback.map((f, n) => `${n + 1}. ${f.text}`).join('\n') : 'None logged';
      const decisionsText = session.decisions.length > 0 ? session.decisions.map((d, n) => `${n + 1}. ${d.text}`).join('\n') : 'None logged';
      const summary = await askAI(`Summarize this music collab session for "${session.trackName}":
IDEAS: ${ideasText}
FEEDBACK: ${feedbackText}
DECISIONS: ${decisionsText}
Give professional summary: overview, key creative directions, main issues, decisions, recommended next steps. Format with emojis.`);
      await respond({
        response_type: 'in_channel',
        blocks: [
          header('📋 Session Summary'),
          section(`*Track:* "${session.trackName}"`),
          divider(),
          twoCol(`💡 *Ideas logged*\n${session.ideas.length}`, `🎚️ *Feedback logged*\n${session.feedback.length}`),
          twoCol(`✅ *Decisions made*\n${session.decisions.length}`, `⏱️ *Started*\n${new Date(session.startedAt).toLocaleTimeString()}`),
          divider(),
          section(summary || 'Could not generate summary. Try again!'),
          divider(),
          context('Use `/wavmind collab end` to end session · `/wavmind collab status` to check progress'),
        ],
      });
      return;
    }

    if (subLower.startsWith('end')) {
      const session = getCollabSession(command.channel_id);
      if (!session) { await respond({ blocks: [header('❗ No Active Session'), section('There is no active collab session in this channel.')] }); return; }
      await respond({ blocks: [header('📋 Generating Final Summary...'), section(`Wrapping up session for *"${session.trackName}"*`), context('⏳ Creating final report...')] });
      const finalSummary = await askAI(`Create a final session report for "${session.trackName}":
IDEAS: ${session.ideas.map(i => i.text).join(', ') || 'None'}
FEEDBACK: ${session.feedback.map(f => f.text).join(', ') || 'None'}
DECISIONS: ${session.decisions.map(d => d.text).join(', ') || 'None'}
Write final report: overview, creative direction, technical decisions, action items, closing note. Format professionally with emojis.`);
      endCollabSession(command.channel_id);
      await respond({
        response_type: 'in_channel',
        blocks: [
          header('🏁 Collab Session Complete'),
          section(`*Track:* "${session.trackName}"\n*Started by:* <@${session.startedBy}>`),
          divider(),
          twoCol(`💡 *Total ideas*\n${session.ideas.length}`, `🎚️ *Total feedback*\n${session.feedback.length}`),
          twoCol(`✅ *Total decisions*\n${session.decisions.length}`, `⏱️ *Started*\n${new Date(session.startedAt).toLocaleTimeString()}`),
          divider(),
          section('📋 *Final Session Report:*'),
          section(finalSummary || 'Could not generate report. Try again!'),
          divider(),
          context('🎛️ Start a new session anytime with `/wavmind collab start "Track Name"`'),
        ],
      });
      return;
    }

    await respond({
      blocks: [
        header('🤝 Collab Mode'),
        section('Work on tracks with your team inside Slack:'),
        divider(),
        section('`/wavmind collab start "Track Name"` — Start a new session\n`/wavmind collab idea [idea]` — Log a production idea\n`/wavmind collab feedback [feedback]` — Log mix feedback\n`/wavmind collab decision [decision]` — Log a final decision\n`/wavmind collab status` — Check session progress\n`/wavmind collab summary` — Get full AI summary\n`/wavmind collab end` — End and archive the session'),
        divider(),
        context('💡 Collab mode tracks everything your team discusses so nothing gets lost'),
      ],
    });
    return;
  }

  // ─── TRENDING ────────────────────────────────────────
  if (lower.startsWith('trending')) {
    const topic = input.slice(8).trim() || 'music production';
    await respond({ blocks: [header('📰 Fetching Latest Music News...'), section(`Searching real-time news for *${topic}*`), context('⏳ Scanning music industry...')] });
    const articles = await getTrendingMusic(topic);
    if (!articles || articles.length === 0) {
      await respond({ blocks: [header('❗ No Results Found'), section(`No news found for *${topic}*.\n\nTry:\n\`/wavmind trending trap\`\n\`/wavmind trending plugins\`\n\`/wavmind trending hip hop\``)] });
      return;
    }
    const newsText = articles.map((a, i) => `${i + 1}. *${a.title}*\n_${a.source} · ${a.date}_${a.description ? '\n' + a.description : ''}`).join('\n\n');
    const aiSummary = await askAI(`Based on these music news about "${topic}":
${articles.map(a => `- ${a.title}: ${a.description}`).join('\n')}
Tell producers: what this means for music production, key trends, how to use them, new tools mentioned. Be specific and actionable.`);
    await respond({
      blocks: [
        header('📰 Music Industry News'),
        section(`*Topic:* ${topic}`),
        divider(),
        section('🔴 *Latest News (Real-Time)*'),
        section(newsText),
        divider(),
        section('🎛️ *What This Means for Producers:*'),
        section(aiSummary || 'Could not generate insights. Try again!'),
        divider(),
        context('💡 Try: `/wavmind trending DAW` · `/wavmind trending plugins` · `/wavmind trending hip hop`'),
      ],
    });
    return;
  }

  // ─── COMPARE ─────────────────────────────────────────
  if (lower.startsWith('compare')) {
    const artists = input.slice(7).trim();
    if (!artists || artists.split(' ').length < 2) {
      await respond({ blocks: [header('❗ Need Two Artists'), section('*Examples:*\n`/wavmind compare Drake and Travis Scott`\n`/wavmind compare Drake vs Travis Scott`')] });
      return;
    }
    await respond({ blocks: [header('🔍 Comparing Artists...'), section(`Looking up *${artists}* on Spotify`), context('⏳ Fetching real audio data...')] });
    let artist1, artist2;
    if (artists.toLowerCase().includes(' and ')) { [artist1, artist2] = artists.split(/\s+and\s+/i).map(s => s.trim()); }
    else if (artists.toLowerCase().includes(' vs ')) { [artist1, artist2] = artists.split(/\s+vs\s+/i).map(s => s.trim()); }
    else { const w = artists.split(' '); const m = Math.ceil(w.length / 2); artist1 = w.slice(0, m).join(' '); artist2 = w.slice(m).join(' '); }
    const [stats1, stats2] = await Promise.all([getArtistStats(artist1), getArtistStats(artist2)]);
    if (!stats1 || !stats2) { await respond({ blocks: [header('❗ Artist Not Found'), section('Could not find one or both artists.\n\nTry:\n`/wavmind compare Drake and Travis Scott`')] }); return; }
    const aiComparison = await askAI(`Compare production styles based on Spotify data:
${stats1.name}: BPM ${stats1.bpm}, Energy ${stats1.energy}%, Danceability ${stats1.danceability}%, Valence ${stats1.valence}%, Loudness ${stats1.loudness}dB, Key ${stats1.key}
${stats2.name}: BPM ${stats2.bpm}, Energy ${stats2.energy}%, Danceability ${stats2.danceability}%, Valence ${stats2.valence}%, Loudness ${stats2.loudness}dB, Key ${stats2.key}
Give: key production differences, what makes each unique, how to blend styles, which genres each suits. Be specific.`);
    await respond({
      blocks: [
        header('🎤 Artist DNA Comparison'),
        section(`*${stats1.name}* vs *${stats2.name}*`),
        divider(),
        section('📊 *Real Spotify Data*'),
        { type: 'section', fields: [{ type: 'mrkdwn', text: `*${stats1.name}*` }, { type: 'mrkdwn', text: `*${stats2.name}*` }] },
        { type: 'section', fields: [{ type: 'mrkdwn', text: `🥁 *BPM*\n${stats1.bpm}` }, { type: 'mrkdwn', text: `🥁 *BPM*\n${stats2.bpm}` }] },
        { type: 'section', fields: [{ type: 'mrkdwn', text: `⚡ *Energy*\n${stats1.energy}%` }, { type: 'mrkdwn', text: `⚡ *Energy*\n${stats2.energy}%` }] },
        { type: 'section', fields: [{ type: 'mrkdwn', text: `💃 *Danceability*\n${stats1.danceability}%` }, { type: 'mrkdwn', text: `💃 *Danceability*\n${stats2.danceability}%` }] },
        { type: 'section', fields: [{ type: 'mrkdwn', text: `😊 *Valence*\n${stats1.valence}%` }, { type: 'mrkdwn', text: `😊 *Valence*\n${stats2.valence}%` }] },
        { type: 'section', fields: [{ type: 'mrkdwn', text: `🔊 *Loudness*\n${stats1.loudness} dB` }, { type: 'mrkdwn', text: `🔊 *Loudness*\n${stats2.loudness} dB` }] },
        { type: 'section', fields: [{ type: 'mrkdwn', text: `🎵 *Common Key*\n${stats1.key}` }, { type: 'mrkdwn', text: `🎵 *Common Key*\n${stats2.key}` }] },
        divider(),
        section('🎛️ *Production Style Analysis:*'),
        section(aiComparison || 'Could not generate comparison. Try again!'),
        divider(),
        context('💡 Use `/wavmind reference [track name]` to analyze a specific song from either artist'),
      ],
    });
    return;
  }

  // ─── IDEAS ───────────────────────────────────────────
  if (lower.startsWith('ideas')) {
    const genre = input.slice(5).trim() || 'general';
    await respond({ blocks: [header('🎵 Generating Track Ideas...'), section(`Genre/mood: *${genre}*`), context('⏳ Thinking creatively...')] });
    const response = await askAI(`You are Wavmind, an expert AI music producer assistant. Generate 5 creative and unique track title ideas with brief concept descriptions for: "${genre}". Format each as: 🎵 *Title* — concept description. Be specific and inspiring.`);
    await respond({
      blocks: [
        header('🎵 Track Ideas'),
        section(`*Genre/Mood:* ${genre}`),
        divider(),
        section(response || 'Could not generate ideas. Try again!'),
        divider(),
        context('💡 Use `/wavmind bpm [genre]` for BPM suggestions · `/wavmind samples drums` for free samples'),
      ],
    });
    return;
  }

  // ─── FEEDBACK ────────────────────────────────────────
  if (lower.startsWith('feedback')) {
    const description = input.slice(8).trim();
    if (!description) {
      await respond({ blocks: [header('❗ Missing Description'), section('*Example:*\n`/wavmind feedback My trap beat at 140bpm feels muddy in the low end`')] });
      return;
    }
    await respond({ blocks: [header('🎚️ Analyzing Your Mix...'), section(`_"${description}"_`), context('⏳ Generating professional feedback...')] });
    const response = await askAI(`You are Wavmind, a professional mixing engineer AI. Give detailed actionable mixing feedback for: "${description}". Include EQ, compression, stereo width, frequency balance advice. Format with clear sections using emojis.`);
    await respond({
      blocks: [
        header('🎚️ Mix Feedback'),
        section(`*Your mix:* _${description}_`),
        divider(),
        section(response || 'Could not analyze. Try again!'),
        divider(),
        context('💡 Upload your MP3/WAV then use `/wavmind mixfeedback bpm:140 key:F_minor` for deeper feedback'),
      ],
    });
    return;
  }

  // ─── MIXFEEDBACK ─────────────────────────────────────
  if (lower.startsWith('mixfeedback')) {
    const parts = input.slice(11).trim();
    const bpmMatch = parts.match(/bpm[:\s]+(\d+)/i);
    const keyMatch = parts.match(/key[:\s]+([\w#b_]+)/i);
    if (!bpmMatch || !keyMatch) {
      await respond({ blocks: [header('❗ Missing BPM or Key'), section('*Format:*\n`/wavmind mixfeedback bpm:140 key:F_minor`\n\n*Key examples:*\n`C_major` · `F_minor` · `G_major` · `A_minor` · `Bb_major`'), context('💡 Find your BPM and Key in your DAW')] });
      return;
    }
    const bpm = parseInt(bpmMatch[1]);
    const key = keyMatch[1].replace(/_/g, ' ');
    const stored = global.pendingAnalysis?.[command.channel_id];
    await respond({ blocks: [header('🎚️ Generating Mix Feedback...'), twoCol(`🥁 *BPM*\n${bpm}`, `🎵 *Key*\n${key}`), context('⏳ Analyzing your track...')] });
    const contextInfo = stored ? `Energy: ${stored.energy}%, Brightness: ${stored.brightness}, Bass presence: ${stored.bass_ratio}%` : '';
    const response = await askAI(`You are Wavmind, a professional mixing engineer. Track details: BPM ${bpm}, Key ${key}. ${contextInfo}
Give specific professional mixing feedback: what BPM and key suggest about genre and mood, EQ advice, compression recommendations, arrangement suggestions, 3 specific improvements. Use real plugin names. Format with emojis.`);
    if (global.pendingAnalysis?.[command.channel_id]) delete global.pendingAnalysis[command.channel_id];
    await respond({
      blocks: [
        header('🎛️ Mix Feedback'),
        twoCol(`🥁 *BPM*\n${bpm}`, `🎵 *Key*\n${key}`),
        stored ? twoCol(`⚡ *Energy*\n${stored.energy}%`, `🔊 *Bass*\n${stored.bass_ratio}%`) : divider(),
        divider(),
        section(response || 'Could not generate feedback. Try again!'),
        divider(),
        context('💡 Use `/wavmind reference [track name]` to compare your sound with a professional mix'),
      ],
    });
    return;
  }

  // ─── REFERENCE ───────────────────────────────────────
  if (lower.startsWith('reference')) {
    const trackQuery = input.slice(9).trim();
    if (!trackQuery) { await respond({ blocks: [header('❗ Missing Track Name'), section('*Example:*\n`/wavmind reference Blinding Lights - The Weeknd`')] }); return; }
    await respond({ blocks: [header('🔍 Looking Up on Spotify...'), section(`Searching for *${trackQuery}*`), context('⏳ Fetching real audio data...')] });
    const features = await getTrackFeatures(trackQuery);
    if (features) {
      const response = await askAI(`You are Wavmind, a professional mixing engineer. Give advice on achieving the sound of:
Track: ${features.name} by ${features.artist}
BPM: ${features.bpm}, Key: ${features.key}, Energy: ${features.energy}%, Danceability: ${features.danceability}%, Loudness: ${features.loudness}dB, Valence: ${features.valence}%
Cover: tempo, key, energy, mixing targets, overall vibe. Be specific.`);
      await respond({
        blocks: [
          header('🎵 Reference Track Analysis'),
          section(`*${features.name}* by *${features.artist}*`),
          divider(),
          section('📊 *Real Spotify Data*'),
          twoCol(`🥁 *BPM*\n${features.bpm}`, `🎵 *Key*\n${features.key}`),
          twoCol(`⚡ *Energy*\n${features.energy}%`, `💃 *Danceability*\n${features.danceability}%`),
          twoCol(`🔊 *Loudness*\n${features.loudness} dB`, `😊 *Valence*\n${features.valence}%`),
          divider(),
          section('🎛️ *How to achieve this sound:*'),
          section(response || 'Could not generate advice. Try again!'),
          divider(),
          context('💡 Upload your track and use `/wavmind mixfeedback` to compare your mix'),
        ],
      });
    } else {
      const response = await askAI(`You are Wavmind, a professional mixing engineer. Give detailed advice on achieving the sound of "${trackQuery}".`);
      await respond({ blocks: [header('🎛️ Reference Analysis'), section(`*Track:* ${trackQuery}`), divider(), section(response || 'Could not analyze. Try again!'), context('💡 Try including the artist name for better results')] });
    }
    return;
  }

  // ─── A&R ─────────────────────────────────────────────
  if (lower.startsWith('ar ') || lower === 'ar') {
    const desc = input.slice(2).trim();
    if (!desc) { await respond({ blocks: [header('❗ Missing Description'), section('*Example:*\n`/wavmind ar Dark trap beat at 140bpm, heavy 808s, melodic piano`')] }); return; }
    await respond({ blocks: [header('🎯 A&R Evaluation in Progress...'), section(`_"${desc}"_`), context('⏳ Label executive AI is reviewing your track...')] });
    const response = await askAI(`You are a senior A&R executive with 20 years experience. Evaluate: "${desc}"
Give detailed evaluation: Commercial Potential (1-10), Playlist Potential, Target Audience, Strengths, Weaknesses, Market Positioning, Verdict (pass/consider/strong interest). Be honest and specific.`);
    await respond({
      blocks: [
        header('🎯 A&R Evaluation'),
        section(`*Track:* _${desc}_`),
        divider(),
        section(response || 'Could not generate evaluation. Try again!'),
        divider(),
        context('💡 `/wavmind release [description]` for release readiness check'),
      ],
    });
    return;
  }

  // ─── RELEASE ─────────────────────────────────────────
  if (lower.startsWith('release')) {
    const desc = input.slice(7).trim();
    if (!desc) { await respond({ blocks: [header('❗ Missing Description'), section('*Example:*\n`/wavmind release Trap beat 140bpm mixed and mastered`')] }); return; }
    await respond({ blocks: [header('✅ Checking Release Readiness...'), section(`_"${desc}"_`), context('⏳ Running pre-release checklist...')] });
    const response = await askAI(`You are a mastering engineer and release consultant. Check release readiness for: "${desc}"
Evaluate: Mix Quality, Loudness (target LUFS), Metadata needed, Distribution platforms, Release strategy, Cover art requirements, Pre-save campaign, Overall Readiness Score X/10. Format as checklist with ✅ or ⚠️.`);
    await respond({
      blocks: [
        header('✅ Release Readiness Report'),
        section(`*Track:* _${desc}_`),
        divider(),
        section(response || 'Could not generate checklist. Try again!'),
        divider(),
        context('💡 `/wavmind ar [description]` for A&R evaluation before releasing'),
      ],
    });
    return;
  }

  // ─── MARKETPLACE ─────────────────────────────────────
  if (lower.startsWith('marketplace')) {
    const desc = input.slice(11).trim();
    if (!desc) { await respond({ blocks: [header('❗ Missing Details'), section('*Example:*\n`/wavmind marketplace dark trap 140bpm F minor`')] }); return; }
    await respond({ blocks: [header('💰 Generating Marketplace Strategy...'), section(`*Beat:* ${desc}`), context('⏳ Analyzing market positioning...')] });
    const response = await askAI(`You are a beat marketplace expert. Create complete strategy for: "${desc}"
Provide: BeatStars Title (SEO), 20 Tags, Description for buyers, YouTube Title, YouTube Description, Price Points (MP3/WAV/trackout/exclusive), Target Artists, Marketing Strategy. Be specific with current market rates.`);
    await respond({
      blocks: [
        header('💰 Marketplace Strategy'),
        section(`*Beat:* ${desc}`),
        divider(),
        section(response || 'Could not generate strategy. Try again!'),
        divider(),
        context('💡 `/wavmind ar [description]` to check commercial potential before listing'),
      ],
    });
    return;
  }

  // ─── BPM ─────────────────────────────────────────────
  if (lower.startsWith('bpm')) {
    const mood = input.slice(3).trim() || 'general';
    await respond({ blocks: [header('🥁 BPM & Key Suggestions'), section(`*Genre/Mood:* ${mood}`), context('⏳ Calculating...')] });
    const response = await askAI(`For "${mood}" suggest: ideal BPM range, best musical keys, chord progressions, typical song structure. Be specific with numbers.`);
    await respond({
      blocks: [
        header('🥁 BPM & Key Suggestions'),
        section(`*Genre/Mood:* ${mood}`),
        divider(),
        section(response || 'Could not generate. Try again!'),
        divider(),
        context('💡 Use `/wavmind chords [key + genre]` · `/wavmind samples drums` for free samples'),
      ],
    });
    return;
  }

  // ─── CHORDS ──────────────────────────────────────────
  if (lower.startsWith('chords')) {
    const query = input.slice(6).trim() || 'C minor trap';
    await respond({ blocks: [header('🎹 Generating Chord Progressions...'), section(`*Query:* ${query}`), context('⏳ Applying music theory...')] });
    const response = await askAI(`Generate 3 chord progressions for: "${query}". For each: chord names, Roman numeral analysis, emotional feel, suggested melody note. Format clearly.`);
    await respond({
      blocks: [
        header('🎹 Chord Progressions'),
        section(`*Query:* ${query}`),
        divider(),
        section(response || 'Could not generate. Try again!'),
        divider(),
        context('💡 Use `/wavmind bpm [genre]` to find the ideal tempo for these chords'),
      ],
    });
    return;
  }

  // ─── TIPS ────────────────────────────────────────────
  if (lower.startsWith('tips')) {
    const topic = input.slice(4).trim() || 'music production';
    await respond({ blocks: [header('💡 Production Tips'), section(`*Topic:* ${topic}`), context('⏳ Loading expert knowledge...')] });
    const response = await askAI(`Give 5 professional actionable tips about "${topic}". Use real techniques and plugin names. Format with emojis and bold titles.`);
    await respond({
      blocks: [
        header('💡 Production Tips'),
        section(`*Topic:* ${topic}`),
        divider(),
        section(response || 'Could not generate. Try again!'),
        divider(),
        context('💡 Use `/wavmind feedback [describe your mix]` to get personalized mixing advice'),
      ],
    });
    return;
  }

  // ─── GENERAL ─────────────────────────────────────────
  await respond({ blocks: [header('🤔 Thinking...'), context('⏳ Processing your question...')] });
  const response = await askAI(`You are Wavmind, an expert AI assistant for music producers. Answer professionally: "${input}"`);
  await respond({
    blocks: [
      header('🎛️ Wavmind'),
      section(response || 'Could not respond. Try again!'),
      divider(),
      context('💡 Type `/wavmind` to see all available commands'),
    ],
  });
});

// ─── APP MENTION ──────────────────────────────────────────
app.event('app_mention', async ({ event, say }) => {
  const input = event.text.replace(/<@[^>]+>/g, '').trim();
  if (!input) { await say({ blocks: getWelcomeBlocks() }); return; }
  const response = await askAI(`You are Wavmind, an expert AI assistant for music producers. Answer professionally: "${input}"`);
  await say({
    blocks: [
      section(`<@${event.user}>`),
      section(response || 'Could not respond. Try again!'),
      divider(),
      context('💡 Type `/wavmind` to see all available commands'),
    ],
  });
});

// ─── DM HANDLER ───────────────────────────────────────────
app.message(async ({ message, say }) => {
  if (message.subtype || !message.text) return;
  const lower = message.text.toLowerCase().trim();
  if (['hi','hello','hey','start','help'].includes(lower)) { await say({ blocks: getWelcomeBlocks() }); return; }
  const response = await askAI(`You are Wavmind, an expert AI for music producers. Answer: "${message.text}"`);
  await say({
    blocks: [
      section(response || 'Could not respond. Try again!'),
      divider(),
      context('💡 Type `/wavmind` to see all available commands'),
    ],
  });
});

// ─── START ────────────────────────────────────────────────
(async () => {
  await app.start();
  console.log('🎛️ Wavmind is running!');
})();
