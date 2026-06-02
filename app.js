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

function gapIndicator(yourVal, refVal, higherIsBetter = true) {
  const diff = yourVal - refVal;
  const absDiff = Math.abs(diff);
  if (absDiff <= 5) return '✅ Match';
  if (higherIsBetter) {
    return diff > 0 ? `✅ +${absDiff}% higher` : `⚠️ ${absDiff}% lower`;
  } else {
    return diff < 0 ? `✅ ${absDiff}% lower` : `⚠️ +${absDiff}% higher`;
  }
}

// ─── COMPARISON SESSIONS ─────────────────────────────────
global.compareSessions = global.compareSessions || {};

function getCompareSession(userId) {
  return global.compareSessions[userId] || null;
}

function startCompareSession(userId) {
  global.compareSessions[userId] = {
    status: 'waiting_your_track',
    yourTrack: null,
    referenceTrack: null,
    channelId: null,
    startedAt: new Date().toISOString(),
  };
  return global.compareSessions[userId];
}

function clearCompareSession(userId) {
  delete global.compareSessions[userId];
}

// ─── COLLAB MODE ─────────────────────────────────────────
global.collabSessions = global.collabSessions || {};
function getCollabSession(channelId) { return global.collabSessions[channelId] || null; }
function startCollabSession(channelId, trackName, userId) {
  global.collabSessions[channelId] = {
    trackName, startedBy: userId,
    startedAt: new Date().toISOString(),
    ideas: [], feedback: [], decisions: [],
  };
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
    section('*🆚 Audio vs Reference Comparison*\n`/wavmind mix compare start` — Start a comparison session\n_Upload your track → upload reference → get instant gap analysis_'),
    section('*🎹 DAW Knowledge*\n`/wavmind daw [daw name] [question]`\n_Real-time tutorials powered by Tavily + Groq AI_\n_Example: `/wavmind daw fl studio how to sidechain 808`_'),
    section('*🎵 Free Samples*\n`/wavmind samples [keywords]`\n_Search 500,000+ free Creative Commons samples_\n_Example: `/wavmind samples drums` · `/wavmind samples piano`_'),
    section('*📰 Trending News*\n`/wavmind trending [topic]`\n_Example: `/wavmind trending plugins`_'),
    section('*🥁 BPM & Key Suggestions*\n`/wavmind bpm [mood or genre]`\n_Example: `/wavmind bpm dark cinematic hip hop`_'),
    section('*🎹 Chord Progressions*\n`/wavmind chords [key + genre]`\n_Example: `/wavmind chords F minor trap`_'),
    section('*💡 Production Tips*\n`/wavmind tips [topic]`\n_Example: `/wavmind tips 808 mixing`_'),
    section('*🎯 A&R Simulation*\n`/wavmind ar [describe your track]`\n_Label executive evaluation_'),
    section('*✅ Release Readiness*\n`/wavmind release [describe your track]`\n_Pre-release checklist_'),
    section('*💰 Beat Marketplace*\n`/wavmind marketplace [genre + BPM + key]`\n_BeatStars tags, SEO titles_'),
    section('*🤝 Collab Mode*\n`/wavmind collab start "Track Name"` · `idea` · `feedback` · `decision` · `summary` · `end`'),
    divider(),
    section('*🎛️ Audio File Analysis*\n*Step 1:* Upload MP3/WAV → auto scan\n*Step 2:* `/wavmind mixfeedback bpm:85 key:F_minor` → AI feedback\n_Key format: `C_major` · `F_minor` · `G_major` · `A_minor` · `Bb_major`_'),
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
          { type: 'section', fields: [{ type: 'mrkdwn', text: '🎵 *Track Ideas*\nGenerate creative track concepts' }, { type: 'mrkdwn', text: '🎚️ *Mix Feedback*\nProfessional mixing advice' }] },
          { type: 'section', fields: [{ type: 'mrkdwn', text: '🔍 *Reference Tracks*\nReal Spotify data + sound blueprint' }, { type: 'mrkdwn', text: '🆚 *Audio Comparison*\nUpload your track vs reference track' }] },
          { type: 'section', fields: [{ type: 'mrkdwn', text: '🎹 *DAW Knowledge*\nReal-time tutorials via Tavily + Groq' }, { type: 'mrkdwn', text: '🎵 *Free Samples*\n500,000+ Creative Commons sounds' }] },
          { type: 'section', fields: [{ type: 'mrkdwn', text: '🎤 *Artist Comparison*\nSpotify DNA analysis' }, { type: 'mrkdwn', text: '📰 *Trending News*\nReal-time music industry updates' }] },
          { type: 'section', fields: [{ type: 'mrkdwn', text: '🥁 *BPM & Key*\nTempo and key suggestions' }, { type: 'mrkdwn', text: '🎹 *Chord Progressions*\nMusic theory-based ideas' }] },
          { type: 'section', fields: [{ type: 'mrkdwn', text: '🎯 *A&R Simulation*\nLabel exec track evaluation' }, { type: 'mrkdwn', text: '✅ *Release Readiness*\nPre-release checklist' }] },
          { type: 'section', fields: [{ type: 'mrkdwn', text: '💰 *Beat Marketplace*\nBeatStars SEO and monetization' }, { type: 'mrkdwn', text: '🤝 *Collab Mode*\nTeam session tracking' }] },
          divider(),
          { type: 'header', text: { type: 'plain_text', text: '🆚 Audio vs Reference Comparison', emoji: true } },
          { type: 'section', text: { type: 'mrkdwn', text: 'Compare your mix against any reference track side by side:\n\n*Step 1:* `/wavmind mix compare start`\n*Step 2:* Upload your track (MP3/WAV)\n*Step 3:* Upload your reference track\n*Step 4:* Get instant gap analysis with AI recommendations\n\n_Wavmind analyzes energy, brightness, bass, BPM and gives you specific advice on closing the gap_' } },
          divider(),
          { type: 'header', text: { type: 'plain_text', text: '🎹 DAW Knowledge Base', emoji: true } },
          { type: 'section', text: { type: 'mrkdwn', text: '`/wavmind daw fl studio how to sidechain 808`\n`/wavmind daw ableton how to warp audio`\n`/wavmind daw logic pro how to use flex pitch`\n`/wavmind daw pro tools how to set up sessions`\n`/wavmind daw cubase how to use chord track`\n\n_Supported: FL Studio · Ableton · Logic Pro · Pro Tools · Cubase · Studio One · GarageBand · Reaper_' } },
          divider(),
          { type: 'header', text: { type: 'plain_text', text: '🚀 Quick Commands', emoji: true } },
          { type: 'section', text: { type: 'mrkdwn', text: '`/wavmind mix compare start` — Start audio comparison\n`/wavmind ideas dark trap beat` — Track ideas\n`/wavmind reference Blinding Lights - The Weeknd` — Reference blueprint\n`/wavmind compare Drake and Travis Scott` — Artist DNA\n`/wavmind daw fl studio how to sidechain 808` — DAW help\n`/wavmind samples drums` — Free samples\n`/wavmind trending plugins` — Music news\n`/wavmind ar dark trap 140bpm heavy 808s` — A&R evaluation\n`/wavmind marketplace dark trap 140bpm F minor` — Monetization' } },
          divider(),
          { type: 'header', text: { type: 'plain_text', text: '📊 Powered By', emoji: true } },
          { type: 'section', fields: [{ type: 'mrkdwn', text: '🤖 *AI*\nGroq — Llama 3.1' }, { type: 'mrkdwn', text: '🎵 *Music*\nSpotify API' }] },
          { type: 'section', fields: [{ type: 'mrkdwn', text: '🔍 *DAW Search*\nTavily Real-Time' }, { type: 'mrkdwn', text: '📰 *News*\nNewsData.io' }] },
          { type: 'section', fields: [{ type: 'mrkdwn', text: '🎵 *Samples*\nFreesound.org 500K+' }, { type: 'mrkdwn', text: '🎧 *Audio*\nLibrosa Python' }] },
          divider(),
          { type: 'context', elements: [{ type: 'mrkdwn', text: '🎛️ *Wavmind* — Built for music producers | Type `/wavmind` to get started' }] },
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

    const userId = event.user_id;
    const channelId = event.channel_id;
    const compareSession = userId ? getCompareSession(userId) : null;

    // ─── COMPARISON MODE ─────────────────────────────────
    if (compareSession) {

      if (compareSession.status === 'waiting_your_track') {
        compareSession.channelId = channelId;
        await client.chat.postMessage({
          channel: channelId,
          blocks: [
            header('🎵 Scanning Your Track...'),
            section(`*File:* ${file.name}`),
            context('⏳ Step 1 of 2 — analyzing your mix...'),
          ],
        });

        const analysis = await analyzeAudioFile(file.url_private_download, file.name);
        if (!analysis || analysis.error) {
          await client.chat.postMessage({
            channel: channelId,
            blocks: [header('❗ Scan Failed'), section(`Could not analyze *${file.name}*. Try MP3 under 10MB.`)],
          });
          return;
        }

        compareSession.yourTrack = {
          filename: file.name,
          energy: analysis.energy,
          brightness: analysis.brightness,
          bass_ratio: analysis.bass_ratio,
          duration: analysis.duration,
        };
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
            section('Upload the track you want to sound like.\n_Example: upload a song by your favorite artist_'),
            context('⏳ Step 2 of 2 · Wavmind will compare both automatically'),
          ],
        });

      } else if (compareSession.status === 'waiting_reference') {
        await client.chat.postMessage({
          channel: channelId,
          blocks: [
            header('🔍 Scanning Reference Track...'),
            section(`*File:* ${file.name}`),
            context('⏳ Generating comparison report...'),
          ],
        });

        const analysis = await analyzeAudioFile(file.url_private_download, file.name);
        if (!analysis || analysis.error) {
          await client.chat.postMessage({
            channel: channelId,
            blocks: [header('❗ Scan Failed'), section(`Could not analyze *${file.name}*. Try MP3 under 10MB.`)],
          });
          return;
        }

        compareSession.referenceTrack = {
          filename: file.name,
          energy: analysis.energy,
          brightness: analysis.brightness,
          bass_ratio: analysis.bass_ratio,
          duration: analysis.duration,
        };

        const yours = compareSession.yourTrack;
        const ref = compareSession.referenceTrack;

        // Energy gap
        const energyDiff = ref.energy - yours.energy;
        const bassDiff = ref.bass_ratio - yours.bass_ratio;

        // Brightness comparison
        const brightnessMap = { 'Dark (heavy low end)': 1, 'Balanced': 2, 'Bright (strong high end)': 3 };
        const yourBright = brightnessMap[yours.brightness] || 2;
        const refBright = brightnessMap[ref.brightness] || 2;
        const brightDiff = refBright - yourBright;

        // Duration
        const yourMins = Math.floor(yours.duration / 60);
        const yourSecs = String(yours.duration % 60).padStart(2, '0');
        const refMins = Math.floor(ref.duration / 60);
        const refSecs = String(ref.duration % 60).padStart(2, '0');

        // Get AI comparison analysis
        const aiAnalysis = await askAI(
          `You are Wavmind, a professional mixing engineer. Compare these two tracks:

YOUR TRACK "${yours.filename}":
Energy: ${yours.energy}%
Brightness: ${yours.brightness}
Bass presence: ${yours.bass_ratio}%
Duration: ${yourMins}:${yourSecs}

REFERENCE TRACK "${ref.filename}":
Energy: ${ref.energy}%
Brightness: ${ref.brightness}
Bass presence: ${ref.bass_ratio}%
Duration: ${refMins}:${refSecs}

Energy gap: ${Math.abs(energyDiff)}% ${energyDiff > 0 ? '(reference is louder/more energetic)' : energyDiff < 0 ? '(your track is more energetic)' : '(matched)'}
Bass gap: ${Math.abs(bassDiff)}% ${bassDiff > 0 ? '(reference has more bass)' : bassDiff < 0 ? '(your track has more bass)' : '(matched)'}
Brightness gap: ${brightDiff > 0 ? 'Reference is brighter' : brightDiff < 0 ? 'Your track is brighter' : 'Matched'}

Give specific actionable advice on how to close each gap. Include:
- What to do with EQ to match the reference brightness
- How to adjust compression to match energy
- Bass treatment recommendations
- Top 3 most important changes to make first
Use real plugin names. Format with clear sections and emojis.`
        );

        clearCompareSession(userId);

        const yourDurationStr = `${yourMins}:${yourSecs}`;
        const refDurationStr = `${refMins}:${refSecs}`;

        await client.chat.postMessage({
          channel: channelId,
          blocks: [
            header('🆚 Mix Comparison Report'),
            divider(),
            // File names
            { type: 'section', fields: [
              { type: 'mrkdwn', text: `🎵 *Your Track*\n${yours.filename}` },
              { type: 'mrkdwn', text: `🎯 *Reference*\n${ref.filename}` },
            ]},
            divider(),
            section('📊 *Side-by-Side Analysis*'),
            // Energy
            { type: 'section', fields: [
              { type: 'mrkdwn', text: `⚡ *Your Energy*\n${yours.energy}%` },
              { type: 'mrkdwn', text: `⚡ *Ref Energy*\n${ref.energy}%  ${energyDiff > 5 ? '⚠️ Ref higher' : energyDiff < -5 ? '✅ You\'re higher' : '✅ Match'}` },
            ]},
            // Bass
            { type: 'section', fields: [
              { type: 'mrkdwn', text: `🔊 *Your Bass*\n${yours.bass_ratio}%` },
              { type: 'mrkdwn', text: `🔊 *Ref Bass*\n${ref.bass_ratio}%  ${bassDiff > 5 ? '⚠️ Ref heavier' : bassDiff < -5 ? '✅ You\'re heavier' : '✅ Match'}` },
            ]},
            // Brightness
            { type: 'section', fields: [
              { type: 'mrkdwn', text: `🌈 *Your Brightness*\n${yours.brightness}` },
              { type: 'mrkdwn', text: `🌈 *Ref Brightness*\n${ref.brightness}  ${brightDiff !== 0 ? '⚠️ Gap detected' : '✅ Match'}` },
            ]},
            // Duration
            { type: 'section', fields: [
              { type: 'mrkdwn', text: `⏱️ *Your Duration*\n${yourDurationStr}` },
              { type: 'mrkdwn', text: `⏱️ *Ref Duration*\n${refDurationStr}` },
            ]},
            divider(),
            header('🤖 AI Gap Analysis'),
            section(aiAnalysis || 'Could not generate analysis. Try again!'),
            divider(),
            section('*🎛️ Next Steps:*\n• Apply the EQ and compression changes above\n• Re-export your track\n• Run `/wavmind mix compare start` again to check your progress'),
            context('💡 Use `/wavmind mixfeedback bpm:140 key:F_minor` for even deeper mix feedback · Start over with `/wavmind mix compare start`'),
          ],
        });
      }
      return;
    }

    // ─── NORMAL UPLOAD MODE ──────────────────────────────
    await client.chat.postMessage({
      channel: channelId,
      blocks: [
        header('🎵 Scanning Your Track...'),
        section(`*File:* ${file.name}\nRunning energy, brightness and bass analysis. Takes about 15 seconds...`),
        context('⏳ Please wait'),
      ],
    });

    const analysis = await analyzeAudioFile(file.url_private_download, file.name);

    if (!analysis || analysis.error) {
      await client.chat.postMessage({
        channel: channelId,
        blocks: [
          header('❗ Scan Failed'),
          section(`Could not analyze *${file.name}*.\n\nTry uploading a smaller file (under 10MB) or use MP3 format.`),
          context(`Error: ${analysis?.error || 'Unknown error'}`),
        ],
      });
      return;
    }

    global.pendingAnalysis = global.pendingAnalysis || {};
    global.pendingAnalysis[channelId] = {
      filename: file.name,
      energy: analysis.energy,
      brightness: analysis.brightness,
      bass_ratio: analysis.bass_ratio,
      duration: analysis.duration,
    };

    const mins = Math.floor(analysis.duration / 60);
    const secs = String(analysis.duration % 60).padStart(2, '0');

    await client.chat.postMessage({
      channel: channelId,
      blocks: [
        header('🎛️ Scan Complete'),
        section(`*File:* ${file.name}`),
        divider(),
        twoCol(`⚡ *Energy*\n${analysis.energy}%`, `🌈 *Brightness*\n${analysis.brightness}`),
        twoCol(`🔊 *Bass Presence*\n${analysis.bass_ratio}%`, `⏱️ *Duration*\n${mins}:${secs}`),
        divider(),
        section('*🎵 What would you like to do?*\n\n• Get mix feedback: `/wavmind mixfeedback bpm:85 key:F_minor`\n• Compare with reference: `/wavmind mix compare start`'),
        context('💡 Key format: `C_major` · `F_minor` · `G_major` · `A_minor` · `Bb_major`'),
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
  const userId = command.user_id;

  if (!input || lower === 'help') {
    await respond({ response_type: 'ephemeral', blocks: getWelcomeBlocks() });
    return;
  }

  // ─── MIX COMPARE ─────────────────────────────────────
  if (lower.startsWith('mix compare') || lower.startsWith('mix-compare')) {
    const sub = lower.includes('start') ? 'start' : lower.includes('cancel') ? 'cancel' : '';

    if (sub === 'cancel') {
      clearCompareSession(userId);
      await respond({
        blocks: [
          header('🗑️ Comparison Cancelled'),
          section('Your comparison session has been cancelled.\n\nStart a new one anytime with `/wavmind mix compare start`'),
        ],
      });
      return;
    }

    const existing = getCompareSession(userId);
    if (existing) {
      await respond({
        blocks: [
          header('⚠️ Session Already Active'),
          section(`You already have a comparison session running.\n\n*Status:* ${existing.status === 'waiting_your_track' ? 'Waiting for your track' : 'Waiting for reference track'}\n\nUpload your ${existing.status === 'waiting_your_track' ? 'track' : 'reference track'} or cancel with \`/wavmind mix compare cancel\``),
        ],
      });
      return;
    }

    startCompareSession(userId);

    await respond({
      response_type: 'in_channel',
      blocks: [
        header('🆚 Mix Comparison Started'),
        section('Compare your mix against any reference track to find the gaps.\n\n*<@' + userId + '> follow these steps:*'),
        divider(),
        section('*Step 1 — Upload YOUR track*\nUpload the beat or song you\'re working on\n_Accepted formats: MP3, WAV, FLAC, AAC_'),
        section('*Step 2 — Upload your REFERENCE track*\nUpload the song you want to sound like\n_Example: a track by your favorite artist_'),
        section('*Step 3 — Get your report*\nWavmind automatically compares both and gives you:\n• Side-by-side energy, bass and brightness analysis\n• Gap score for each element\n• Specific AI advice on how to close the gaps'),
        divider(),
        context('💡 Upload your track now · Cancel anytime with `/wavmind mix compare cancel`'),
      ],
    });
    return;
  }

  // ─── DAW KNOWLEDGE ───────────────────────────────────
  if (lower.startsWith('daw')) {
    const dawInput = input.slice(3).trim();

    if (!dawInput) {
      await respond({
        blocks: [
          header('🎹 DAW Knowledge Base'),
          section('Get real-time step-by-step tutorials for any DAW.\n\n*Format:*\n`/wavmind daw [daw name] [your question]`\n\n*Examples:*\n`/wavmind daw fl studio how to sidechain 808`\n`/wavmind daw ableton how to warp audio`\n`/wavmind daw logic pro how to use flex pitch`\n`/wavmind daw pro tools how to set up sessions`\n`/wavmind daw cubase how to use chord track`'),
          divider(),
          section('*Supported DAWs:*\nFL Studio · Ableton Live · Logic Pro · Pro Tools · Cubase · Studio One · GarageBand · Reason · Bitwig · Reaper'),
          context('💡 Powered by Tavily real-time search + Groq AI'),
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
      await respond({
        blocks: [
          header('❗ DAW Not Recognized'),
          section(`Could not detect which DAW from: *"${dawInput}"*\n\n*Example:*\n\`/wavmind daw fl studio how to sidechain 808\``),
          context('Supported: FL Studio · Ableton Live · Logic Pro · Pro Tools · Cubase · Studio One · GarageBand · Reason · Bitwig · Reaper'),
        ],
      });
      return;
    }

    await respond({
      blocks: [
        header(`🎹 ${detectedDAW} — Looking Up...`),
        section(`*Question:* ${question || 'General help'}`),
        context('⏳ Searching web + generating AI answer...'),
      ],
    });

    const searchQuery = `${detectedDAW} ${question} tutorial step by step`;
    const [tavilyData, aiBase] = await Promise.all([
      tavilySearch(searchQuery),
      askAI(`You are Wavmind, an expert ${detectedDAW} instructor. Answer this about ${detectedDAW}: "${question}". Give clear step-by-step instructions. Format with numbered steps and bold key terms.`),
    ]);

    const blocks = [
      header(`🎹 ${detectedDAW}: ${question}`),
      divider(),
      section('🤖 *AI Answer:*'),
      section(aiBase || 'Could not generate answer.'),
    ];

    if (tavilyData) {
      if (tavilyData.answer) {
        blocks.push(divider(), section('🌐 *From the Web:*'), section(tavilyData.answer));
      }
      if (tavilyData.results?.length > 0) {
        blocks.push(
          divider(),
          section('📚 *Helpful Resources:*'),
          section(tavilyData.results.slice(0, 4).map(r => `• <${r.url}|${r.title}>`).join('\n'))
        );
      }
    }

    blocks.push(
      divider(),
      context(`🎹 ${detectedDAW} · Tavily + Groq AI · Try \`/wavmind daw ${detectedDAW.toLowerCase()} [another question]\``)
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
          section('*Examples:*\n`/wavmind samples drums`\n`/wavmind samples piano`\n`/wavmind samples bass`\n`/wavmind samples guitar`\n`/wavmind samples synth`\n`/wavmind samples ambient`'),
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
          section(`_No exact results for "${query}" — showing "${simpleQuery}"_`),
          divider(),
        ];
        retrySounds.forEach((sound, i) => {
          soundBlocks.push(section(
            `*${i + 1}. ${sound.name}*\n` +
            `⏱️ *${sound.duration}s* · ⭐ *${sound.rating}/5* · 📥 *${sound.downloads.toLocaleString()}*\n` +
            `📄 *License:* ${sound.license}\n` +
            `🏷️ ${sound.tags}\n` +
            `👤 By *${sound.username}*\n\n` +
            `${sound.preview ? `🔊 *<${sound.preview}|▶ Listen>*\n` : ''}` +
            `🔗 *<${sound.url}|📥 Download on Freesound>*`
          ));
          if (i < retrySounds.length - 1) soundBlocks.push(divider());
        });
        soundBlocks.push(divider(), context('🎵 Powered by Freesound.org'));
        await respond({ blocks: soundBlocks });
      } else {
        await respond({
          blocks: [
            header('❗ No Samples Found'),
            section(`No sounds found for *"${query}"*.\n\nTry simpler keywords:\n• \`/wavmind samples drums\`\n• \`/wavmind samples piano\`\n• \`/wavmind samples bass\``),
            section(`🔗 *<https://freesound.org/search/?q=${encodeURIComponent(query)}|Browse on Freesound.org>*`),
          ],
        });
      }
      return;
    }

    const aiTip = await askAI(`Producer found "${query}" samples: ${sounds.slice(0, 3).map(s => s.name).join(', ')}. Give 2-3 tips on using these in music production. Under 80 words. Bullet points.`);

    const soundBlocks = [
      header(`🎵 Free Samples: "${query}"`),
      section(`Found *${sounds.length} sounds* — all free to use`),
      context('💡 Click Listen to preview · Click Download to get full file'),
      divider(),
    ];

    sounds.forEach((sound, i) => {
      soundBlocks.push(section(
        `*${i + 1}. ${sound.name}*\n` +
        `⏱️ *Duration:* ${sound.duration}s · ⭐ *${sound.rating}/5* · 📥 *${sound.downloads.toLocaleString()}*\n` +
        `📄 *License:* ${sound.license}\n` +
        `🏷️ *Tags:* ${sound.tags}\n` +
        `👤 *By:* ${sound.username}\n\n` +
        `${sound.preview ? `🔊 *<${sound.preview}|▶ Listen to Preview>*     ` : ''}` +
        `🔗 *<${sound.url}|📥 View & Download on Freesound>*`
      ));
      if (i < sounds.length - 1) soundBlocks.push(divider());
    });

    if (aiTip) soundBlocks.push(divider(), header('💡 Production Tips'), section(aiTip));
    soundBlocks.push(
      divider(),
      section(`🔗 *<https://freesound.org/search/?q=${encodeURIComponent(query)}|Browse more on Freesound.org>*`),
      context('🎵 All sounds Creative Commons · Powered by Freesound.org')
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
        await respond({ blocks: [header('⚠️ Session Active'), section(`Session for *"${existing.trackName}"* running.\n\`/wavmind collab end\` to finish.`)] });
        return;
      }
      startCollabSession(command.channel_id, trackName, userId);
      await respond({
        response_type: 'in_channel',
        blocks: [
          header('🤝 Collab Session Started'),
          section(`*Track:* "${trackName}"\n*Started by:* <@${userId}>`),
          divider(),
          twoCol('💡 *Log idea*\n`/wavmind collab idea [idea]`', '🎚️ *Log feedback*\n`/wavmind collab feedback [fb]`'),
          twoCol('✅ *Log decision*\n`/wavmind collab decision [dec]`', '📋 *Get summary*\n`/wavmind collab summary`'),
          context(`Session active · /wavmind collab end to finish`),
        ],
      });
      return;
    }

    if (subLower.startsWith('idea')) {
      const idea = subInput.slice(4).trim();
      const session = getCollabSession(command.channel_id);
      if (!session) { await respond({ blocks: [header('❗ No Session'), section('`/wavmind collab start "Track Name"`')] }); return; }
      if (!idea) { await respond({ blocks: [header('❗ Missing'), section('`/wavmind collab idea [idea]`')] }); return; }
      session.ideas.push({ text: idea, user: userId, time: new Date().toISOString() });
      await respond({ response_type: 'in_channel', blocks: [header('💡 Idea Logged'), section(`*"${idea}"*\n— <@${userId}>`), context(`${session.ideas.length} ideas for "${session.trackName}"`)] });
      return;
    }

    if (subLower.startsWith('feedback')) {
      const fb = subInput.slice(8).trim();
      const session = getCollabSession(command.channel_id);
      if (!session) { await respond({ blocks: [header('❗ No Session'), section('`/wavmind collab start "Track Name"`')] }); return; }
      if (!fb) { await respond({ blocks: [header('❗ Missing'), section('`/wavmind collab feedback [feedback]`')] }); return; }
      session.feedback.push({ text: fb, user: userId, time: new Date().toISOString() });
      await respond({ response_type: 'in_channel', blocks: [header('🎚️ Feedback Logged'), section(`*"${fb}"*\n— <@${userId}>`), context(`${session.feedback.length} feedback for "${session.trackName}"`)] });
      return;
    }

    if (subLower.startsWith('decision')) {
      const dec = subInput.slice(8).trim();
      const session = getCollabSession(command.channel_id);
      if (!session) { await respond({ blocks: [header('❗ No Session'), section('`/wavmind collab start "Track Name"`')] }); return; }
      if (!dec) { await respond({ blocks: [header('❗ Missing'), section('`/wavmind collab decision [decision]`')] }); return; }
      session.decisions.push({ text: dec, user: userId, time: new Date().toISOString() });
      await respond({ response_type: 'in_channel', blocks: [header('✅ Decision Logged'), section(`*"${dec}"*\n— <@${userId}>`), context(`${session.decisions.length} decisions for "${session.trackName}"`)] });
      return;
    }

    if (subLower.startsWith('status')) {
      const session = getCollabSession(command.channel_id);
      if (!session) { await respond({ blocks: [header('❗ No Session'), section('`/wavmind collab start "Track Name"`')] }); return; }
      await respond({
        blocks: [
          header('📊 Session Status'),
          section(`*Track:* "${session.trackName}"\n*By:* <@${session.startedBy}>`),
          divider(),
          twoCol(`💡 *Ideas*\n${session.ideas.length}`, `🎚️ *Feedback*\n${session.feedback.length}`),
          twoCol(`✅ *Decisions*\n${session.decisions.length}`, `⏱️ *Started*\n${new Date(session.startedAt).toLocaleTimeString()}`),
          context('`/wavmind collab summary` · `/wavmind collab end`'),
        ],
      });
      return;
    }

    if (subLower.startsWith('summary')) {
      const session = getCollabSession(command.channel_id);
      if (!session) { await respond({ blocks: [header('❗ No Session'), section('`/wavmind collab start "Track Name"`')] }); return; }
      await respond({ blocks: [header('📋 Generating...'), context('⏳')] });
      const summary = await askAI(`Summarize collab for "${session.trackName}":
IDEAS: ${session.ideas.map(i => i.text).join(', ') || 'None'}
FEEDBACK: ${session.feedback.map(f => f.text).join(', ') || 'None'}
DECISIONS: ${session.decisions.map(d => d.text).join(', ') || 'None'}
Give: overview, creative directions, issues, next steps. Format with emojis.`);
      await respond({
        response_type: 'in_channel',
        blocks: [
          header('📋 Session Summary'),
          section(`*Track:* "${session.trackName}"`),
          divider(),
          twoCol(`💡 *Ideas*\n${session.ideas.length}`, `🎚️ *Feedback*\n${session.feedback.length}`),
          twoCol(`✅ *Decisions*\n${session.decisions.length}`, `⏱️ *Started*\n${new Date(session.startedAt).toLocaleTimeString()}`),
          divider(),
          section(summary || 'Could not generate.'),
          context('`/wavmind collab end` to finish'),
        ],
      });
      return;
    }

    if (subLower.startsWith('end')) {
      const session = getCollabSession(command.channel_id);
      if (!session) { await respond({ blocks: [header('❗ No Session')] }); return; }
      const finalSummary = await askAI(`Final report for "${session.trackName}":
IDEAS: ${session.ideas.map(i => i.text).join(', ') || 'None'}
FEEDBACK: ${session.feedback.map(f => f.text).join(', ') || 'None'}
DECISIONS: ${session.decisions.map(d => d.text).join(', ') || 'None'}
Write: overview, decisions, action items, closing note.`);
      endCollabSession(command.channel_id);
      await respond({
        response_type: 'in_channel',
        blocks: [
          header('🏁 Collab Complete'),
          section(`*Track:* "${session.trackName}"`),
          divider(),
          twoCol(`💡 *Ideas*\n${session.ideas.length}`, `🎚️ *Feedback*\n${session.feedback.length}`),
          divider(),
          section(finalSummary || 'Could not generate.'),
          context('`/wavmind collab start "Name"` for new session'),
        ],
      });
      return;
    }

    await respond({ blocks: [header('🤝 Collab Mode'), section('`start` · `idea` · `feedback` · `decision` · `summary` · `end`')] });
    return;
  }

  // ─── TRENDING ────────────────────────────────────────
  if (lower.startsWith('trending')) {
    const topic = input.slice(8).trim() || 'music production';
    await respond({ blocks: [header('📰 Fetching Music News...'), context('⏳')] });
    const articles = await getTrendingMusic(topic);
    if (!articles) { await respond({ blocks: [header('❗ No Results'), section('Try `/wavmind trending plugins`')] }); return; }
    const newsText = articles.map((a, i) => `${i + 1}. *${a.title}*\n_${a.source} · ${a.date}_${a.description ? '\n' + a.description : ''}`).join('\n\n');
    const aiSummary = await askAI(`Based on music news about "${topic}": ${articles.map(a => a.title).join(', ')}. What does this mean for producers? Key trends and how to use them. Be specific.`);
    await respond({
      blocks: [
        header('📰 Music Industry News'),
        section(`*Topic:* ${topic}`),
        divider(),
        section('🔴 *Latest News*'),
        section(newsText),
        divider(),
        section('🎛️ *What This Means for Producers:*'),
        section(aiSummary || 'Could not generate.'),
        context('`/wavmind trending DAW` · `/wavmind trending plugins`'),
      ],
    });
    return;
  }

  // ─── COMPARE ─────────────────────────────────────────
  if (lower.startsWith('compare')) {
    const artists = input.slice(7).trim();
    if (!artists || artists.split(' ').length < 2) {
      await respond({ blocks: [header('❗ Need Two Artists'), section('`/wavmind compare Drake and Travis Scott`')] });
      return;
    }
    await respond({ blocks: [header('🔍 Comparing...'), context('⏳')] });
    let a1, a2;
    if (artists.toLowerCase().includes(' and ')) { [a1, a2] = artists.split(/\s+and\s+/i).map(s => s.trim()); }
    else if (artists.toLowerCase().includes(' vs ')) { [a1, a2] = artists.split(/\s+vs\s+/i).map(s => s.trim()); }
    else { const w = artists.split(' '); const m = Math.ceil(w.length / 2); a1 = w.slice(0, m).join(' '); a2 = w.slice(m).join(' '); }
    const [s1, s2] = await Promise.all([getArtistStats(a1), getArtistStats(a2)]);
    if (!s1 || !s2) { await respond({ blocks: [header('❗ Not Found'), section('`/wavmind compare Drake and Travis Scott`')] }); return; }
    const aiComp = await askAI(`Compare: ${s1.name} (BPM ${s1.bpm}, Energy ${s1.energy}%, Dance ${s1.danceability}%, Valence ${s1.valence}%, Loud ${s1.loudness}dB) vs ${s2.name} (BPM ${s2.bpm}, Energy ${s2.energy}%, Dance ${s2.danceability}%, Valence ${s2.valence}%, Loud ${s2.loudness}dB). Key differences, unique sounds, how to blend.`);
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
        section(aiComp || 'Could not generate.'),
        context('`/wavmind reference [track]` to analyze a specific song'),
      ],
    });
    return;
  }

  // ─── IDEAS ───────────────────────────────────────────
  if (lower.startsWith('ideas')) {
    const genre = input.slice(5).trim() || 'general';
    await respond({ blocks: [header('🎵 Generating...'), section(`*Genre:* ${genre}`), context('⏳')] });
    const response = await askAI(`Generate 5 creative track title ideas with concept descriptions for: "${genre}". Format: 🎵 *Title* — concept. Be specific.`);
    await respond({ blocks: [header('🎵 Track Ideas'), section(`*Genre:* ${genre}`), divider(), section(response || 'Error'), context('`/wavmind bpm [genre]` for BPM · `/wavmind samples drums` for samples')] });
    return;
  }

  // ─── FEEDBACK ────────────────────────────────────────
  if (lower.startsWith('feedback')) {
    const desc = input.slice(8).trim();
    if (!desc) { await respond({ blocks: [header('❗ Missing'), section('`/wavmind feedback My beat feels muddy at 140bpm`')] }); return; }
    await respond({ blocks: [header('🎚️ Analyzing...'), section(`_"${desc}"_`), context('⏳')] });
    const response = await askAI(`Professional mixing feedback for: "${desc}". Include EQ, compression, stereo width, frequency balance. Format with emojis.`);
    await respond({ blocks: [header('🎚️ Mix Feedback'), section(`_${desc}_`), divider(), section(response || 'Error'), context('Upload MP3/WAV then `/wavmind mixfeedback bpm:140 key:F_minor` for deeper feedback')] });
    return;
  }

  // ─── MIXFEEDBACK ─────────────────────────────────────
  if (lower.startsWith('mixfeedback')) {
    const parts = input.slice(11).trim();
    const bpmM = parts.match(/bpm[:\s]+(\d+)/i);
    const keyM = parts.match(/key[:\s]+([\w#b_]+)/i);
    if (!bpmM || !keyM) { await respond({ blocks: [header('❗ Missing'), section('`/wavmind mixfeedback bpm:140 key:F_minor`')] }); return; }
    const bpm = parseInt(bpmM[1]); const key = keyM[1].replace(/_/g, ' ');
    const stored = global.pendingAnalysis?.[command.channel_id];
    await respond({ blocks: [header('🎚️ Generating...'), twoCol(`🥁 *BPM*\n${bpm}`, `🎵 *Key*\n${key}`), context('⏳')] });
    const ctx = stored ? `Energy: ${stored.energy}%, Brightness: ${stored.brightness}, Bass: ${stored.bass_ratio}%` : '';
    const response = await askAI(`Professional mix feedback for BPM ${bpm}, Key ${key}. ${ctx}. EQ, compression, arrangement advice. Use real plugin names.`);
    if (global.pendingAnalysis?.[command.channel_id]) delete global.pendingAnalysis[command.channel_id];
    await respond({
      blocks: [
        header('🎛️ Mix Feedback'),
        twoCol(`🥁 *BPM*\n${bpm}`, `🎵 *Key*\n${key}`),
        stored ? twoCol(`⚡ *Energy*\n${stored.energy}%`, `🔊 *Bass*\n${stored.bass_ratio}%`) : divider(),
        divider(),
        section(response || 'Error'),
        context('`/wavmind reference [track]` to compare with pro mix · `/wavmind mix compare start` to compare audio files'),
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
      const response = await askAI(`Advice on achieving sound of ${f.name} by ${f.artist}: BPM ${f.bpm}, Key ${f.key}, Energy ${f.energy}%, Danceability ${f.danceability}%, Loudness ${f.loudness}dB. Cover tempo, key, mixing targets, vibe.`);
      await respond({
        blocks: [
          header('🎵 Reference Analysis'),
          section(`*${f.name}* by *${f.artist}*`),
          divider(),
          twoCol(`🥁 *BPM*\n${f.bpm}`, `🎵 *Key*\n${f.key}`),
          twoCol(`⚡ *Energy*\n${f.energy}%`, `💃 *Dance*\n${f.danceability}%`),
          twoCol(`🔊 *Loudness*\n${f.loudness} dB`, `😊 *Valence*\n${f.valence}%`),
          divider(),
          section(response || 'Error'),
          context('`/wavmind mix compare start` to compare your audio vs this reference'),
        ],
      });
    } else {
      const response = await askAI(`Advice on achieving sound of "${q}". Cover tempo, key, drums, bass, melody, mix approach.`);
      await respond({ blocks: [header('🎛️ Reference Analysis'), section(`*${q}*`), divider(), section(response || 'Error')] });
    }
    return;
  }

  // ─── A&R ─────────────────────────────────────────────
  if (lower.startsWith('ar ') || lower === 'ar') {
    const desc = input.slice(2).trim();
    if (!desc) { await respond({ blocks: [header('❗ Missing'), section('`/wavmind ar Dark trap 140bpm heavy 808s`')] }); return; }
    await respond({ blocks: [header('🎯 A&R Evaluation...'), section(`_"${desc}"_`), context('⏳')] });
    const response = await askAI(`Senior A&R executive evaluation of: "${desc}". Commercial Potential (1-10), Playlist Potential, Target Audience, Strengths, Weaknesses, Verdict. Be honest.`);
    await respond({ blocks: [header('🎯 A&R Evaluation'), section(`_${desc}_`), divider(), section(response || 'Error'), context('`/wavmind release [description]` for release readiness')] });
    return;
  }

  // ─── RELEASE ─────────────────────────────────────────
  if (lower.startsWith('release')) {
    const desc = input.slice(7).trim();
    if (!desc) { await respond({ blocks: [header('❗ Missing'), section('`/wavmind release Trap beat 140bpm mixed`')] }); return; }
    await respond({ blocks: [header('✅ Checking...'), context('⏳')] });
    const response = await askAI(`Release readiness for: "${desc}". Evaluate: Mix Quality, Loudness LUFS, Metadata, Distribution, Strategy, Cover art, Pre-save, Score X/10. Format as checklist ✅ or ⚠️.`);
    await respond({ blocks: [header('✅ Release Readiness'), section(`_${desc}_`), divider(), section(response || 'Error'), context('`/wavmind ar [description]` for A&R eval')] });
    return;
  }

  // ─── MARKETPLACE ─────────────────────────────────────
  if (lower.startsWith('marketplace')) {
    const desc = input.slice(11).trim();
    if (!desc) { await respond({ blocks: [header('❗ Missing'), section('`/wavmind marketplace dark trap 140bpm F minor`')] }); return; }
    await respond({ blocks: [header('💰 Generating...'), context('⏳')] });
    const response = await askAI(`Beat marketplace strategy for: "${desc}". BeatStars Title, 20 Tags, Description, YouTube Title, YouTube Description, Price Points, Target Artists, Marketing. Specific market rates.`);
    await respond({ blocks: [header('💰 Marketplace Strategy'), section(`*Beat:* ${desc}`), divider(), section(response || 'Error'), context('`/wavmind ar [description]` for commercial potential')] });
    return;
  }

  // ─── BPM ─────────────────────────────────────────────
  if (lower.startsWith('bpm')) {
    const mood = input.slice(3).trim() || 'general';
    await respond({ blocks: [header('🥁 BPM & Key'), section(`*Genre:* ${mood}`), context('⏳')] });
    const response = await askAI(`For "${mood}": ideal BPM range, best keys, chord progressions, song structure. Be specific.`);
    await respond({ blocks: [header('🥁 BPM & Key'), section(`*Genre:* ${mood}`), divider(), section(response || 'Error'), context('`/wavmind chords [key + genre]`')] });
    return;
  }

  // ─── CHORDS ──────────────────────────────────────────
  if (lower.startsWith('chords')) {
    const query = input.slice(6).trim() || 'C minor trap';
    await respond({ blocks: [header('🎹 Chord Progressions...'), context('⏳')] });
    const response = await askAI(`3 chord progressions for "${query}". Each: chord names, Roman numerals, emotional feel, melody note.`);
    await respond({ blocks: [header('🎹 Chord Progressions'), section(`*${query}*`), divider(), section(response || 'Error'), context('`/wavmind bpm [genre]`')] });
    return;
  }

  // ─── TIPS ────────────────────────────────────────────
  if (lower.startsWith('tips')) {
    const topic = input.slice(4).trim() || 'music production';
    await respond({ blocks: [header('💡 Tips'), section(`*${topic}*`), context('⏳')] });
    const response = await askAI(`5 professional tips about "${topic}". Real techniques and plugin names. Emojis and bold titles.`);
    await respond({ blocks: [header('💡 Production Tips'), section(`*${topic}*`), divider(), section(response || 'Error'), context('`/wavmind feedback [mix]` for personalized advice')] });
    return;
  }

  // ─── GENERAL ─────────────────────────────────────────
  await respond({ blocks: [header('🤔 Thinking...'), context('⏳')] });
  const response = await askAI(`You are Wavmind, expert AI for music producers. Answer: "${input}"`);
  await respond({ blocks: [header('🎛️ Wavmind'), section(response || 'Error'), context('`/wavmind` for all commands')] });
});

// ─── APP MENTION ──────────────────────────────────────────
app.event('app_mention', async ({ event, say }) => {
  const input = event.text.replace(/<@[^>]+>/g, '').trim();
  if (!input) { await say({ blocks: getWelcomeBlocks() }); return; }
  const response = await askAI(`You are Wavmind, expert AI for music producers. Answer: "${input}"`);
  await say({ blocks: [section(`<@${event.user}>`), section(response || 'Error'), context('`/wavmind` for all commands')] });
});

// ─── DM HANDLER ───────────────────────────────────────────
app.message(async ({ message, say }) => {
  if (message.subtype || !message.text) return;
  const lower = message.text.toLowerCase().trim();
  if (['hi','hello','hey','start','help'].includes(lower)) { await say({ blocks: getWelcomeBlocks() }); return; }
  const response = await askAI(`You are Wavmind, expert AI for music producers. Answer: "${message.text}"`);
  await say({ blocks: [section(response || 'Error'), context('`/wavmind` for all commands')] });
});

// ─── START ────────────────────────────────────────────────
(async () => {
  await app.start();
  console.log('🎛️ Wavmind is running!');
})();
