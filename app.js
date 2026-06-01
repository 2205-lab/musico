require('dotenv').config();
const { App } = require('@slack/bolt');
const Groq = require('groq-sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const memory = require('./memory');

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
    const featurePromises = tracks.map(t =>
      axios.get(`https://api.spotify.com/v1/audio-features/${t.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    );
    const featuresRes = await Promise.all(featurePromises);
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
    const query = encodeURIComponent(topic + ' music producer DAW plugin');
    const url = `https://newsdata.io/api/1/news?apikey=${process.env.NEWSDATA_API_KEY}&q=${query}&language=en&category=entertainment,technology`;
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
const divider = () => ({ type: 'divider' });
const header = (text) => ({ type: 'header', text: { type: 'plain_text', text, emoji: true } });
const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });
const twoCol = (left, right) => ({ type: 'section', fields: [{ type: 'mrkdwn', text: left }, { type: 'mrkdwn', text: right }] });
const context = (text) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

// ─── COLLAB MODE ─────────────────────────────────────────
global.collabSessions = global.collabSessions || {};
const getCollabSession = (id) => global.collabSessions[id] || null;
const startCollabSession = (channelId, trackName, userId) => {
  global.collabSessions[channelId] = { trackName, startedBy: userId, startedAt: new Date().toISOString(), ideas: [], feedback: [], decisions: [] };
  return global.collabSessions[channelId];
};
const endCollabSession = (id) => { const s = global.collabSessions[id]; delete global.collabSessions[id]; return s; };

// ─── WELCOME BLOCKS ───────────────────────────────────────
function getWelcomeBlocks() {
  return [
    header('🎛️ Welcome to Wavmind'),
    section('*Your autonomous AI assistant for music producers.* Here\'s everything I can do:'),
    divider(),
    section('*🧠 Producer Memory*\n`/wavmind project new "Track Name"` — Start a new project\n`/wavmind project` — View your current project\n`/wavmind project set bpm:140 key:F_minor genre:trap` — Update project details'),
    section('*🎵 Track Ideas 2.0*\n`/wavmind ideas [genre/mood]`\n_Full production concept with BPM, key, instruments and arrangement_'),
    section('*🎚️ Mix Feedback + Action Plan*\n`/wavmind feedback [describe your mix]`\n_Get feedback AND an actionable checklist to fix issues_'),
    section('*🔍 Reference Track Blueprint*\n`/wavmind reference [track - artist]`\n_Full blueprint with structure, energy curve and production insights_'),
    section('*🎤 Artist DNA Comparison*\n`/wavmind compare [artist1] and [artist2]`\n_Deep production style analysis with real Spotify data_'),
    section('*📰 Music Industry News*\n`/wavmind trending [topic]`\n_Real-time DAW updates, plugin releases and producer opportunities_'),
    section('*🥁 BPM & Key*\n`/wavmind bpm [mood or genre]`'),
    section('*🎹 Chord Progressions*\n`/wavmind chords [key + genre]`'),
    section('*💡 Production Tips*\n`/wavmind tips [topic]`'),
    divider(),
    section('*🏆 Agent Features*'),
    section('*🎯 A&R Simulation*\n`/wavmind ar [describe your track]`\n_Label executive evaluation of commercial potential_'),
    section('*✅ Release Readiness*\n`/wavmind release [describe your track]`\n_Pre-release checklist for mix, metadata and distribution_'),
    section('*💰 Beat Marketplace Advisor*\n`/wavmind marketplace [genre + BPM + key]`\n_BeatStars tags, SEO titles, YouTube descriptions_'),
    section('*🚀 Career Path Finder*\n`/wavmind career`\n_Discover your ideal music industry career path_'),
    section('*📅 Production Sprint*\n`/wavmind sprint [goal]`\n_Weekly production plan with tasks and milestones_'),
    section('*🤝 Collab Mode*\n`/wavmind collab start "Track Name"` · `idea` · `feedback` · `decision` · `summary` · `end`'),
    divider(),
    section('*🎛️ Audio File Analysis*\n*Step 1:* Upload MP3 or WAV → Wavmind scans energy, brightness and bass\n*Step 2:* `/wavmind mixfeedback bpm:85 key:F_minor` → Get professional AI feedback + action plan'),
    divider(),
    context('💬 Or just @mention me and ask anything about music production!'),
  ];
}

// ─── APP HOME ─────────────────────────────────────────────
async function publishAppHome(client, userId) {
  const project = memory.getProject(userId);
  const actionPlan = memory.getActionPlan(userId);
  const sprint = memory.getSprintPlan(userId);

  const projectBlocks = project ? [
    { type: 'divider' },
    { type: 'header', text: { type: 'plain_text', text: '🎵 Your Current Project', emoji: true } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `🎵 *Track*\n${project.name}` },
        { type: 'mrkdwn', text: `🥁 *BPM*\n${project.bpm || 'Not set'}` },
      ],
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `🎼 *Key*\n${project.key || 'Not set'}` },
        { type: 'mrkdwn', text: `🎸 *Genre*\n${project.genre || 'Not set'}` },
      ],
    },
    project.references.length > 0 ? {
      type: 'section',
      text: { type: 'mrkdwn', text: `🔍 *References:* ${project.references.join(', ')}` },
    } : null,
    project.tasks.length > 0 ? {
      type: 'section',
      text: { type: 'mrkdwn', text: `📋 *Pending Tasks:*\n${project.tasks.slice(0, 3).map(t => `• ${t}`).join('\n')}` },
    } : null,
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_Last updated: ${new Date(project.updatedAt).toLocaleString()}_` }],
    },
  ].filter(Boolean) : [
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '🎵 *No active project*\nStart one with `/wavmind project new "Track Name"`' },
    },
  ];

  const actionPlanBlocks = actionPlan ? [
    { type: 'divider' },
    { type: 'header', text: { type: 'plain_text', text: '📋 Your Action Plan', emoji: true } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: actionPlan.items.map((item, i) =>
          actionPlan.completed.includes(i) ? `✅ ~${item}~` : `☐ ${item}`
        ).join('\n'),
      },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${actionPlan.completed.length}/${actionPlan.items.length} tasks completed · Use \`/wavmind task done [number]\` to mark complete` }],
    },
  ] : [];

  const sprintBlocks = sprint ? [
    { type: 'divider' },
    { type: 'header', text: { type: 'plain_text', text: '🚀 Production Sprint', emoji: true } },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Goal:* ${sprint.goal}\n\n${sprint.tasks.map((t, i) => sprint.completed.includes(i) ? `✅ ~${t}~` : `☐ ${t}`).join('\n')}` },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${sprint.completed.length}/${sprint.tasks.length} tasks done · Created ${new Date(sprint.createdAt).toLocaleDateString()}` }],
    },
  ] : [];

  await client.views.publish({
    user_id: userId,
    view: {
      type: 'home',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*🎛️ Wavmind*\n_Your autonomous AI assistant for music producers_' },
        },
        ...projectBlocks,
        ...actionPlanBlocks,
        ...sprintBlocks,
        { type: 'divider' },
        { type: 'header', text: { type: 'plain_text', text: '🚀 Quick Commands', emoji: true } },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '`/wavmind project new "Track Name"` — Start a project\n`/wavmind ideas dark trap beat` — Full production concept\n`/wavmind reference Blinding Lights - The Weeknd` — Track blueprint\n`/wavmind compare Drake and Travis Scott` — Artist DNA\n`/wavmind ar [describe track]` — A&R evaluation\n`/wavmind release [describe track]` — Release checklist\n`/wavmind marketplace trap 140bpm F minor` — Monetization tips\n`/wavmind career` — Find your career path\n`/wavmind sprint Finish EP this week` — Weekly plan\n`/wavmind trending plugins` — Latest music news',
          },
        },
        { type: 'divider' },
        { type: 'header', text: { type: 'plain_text', text: '🎛️ All Features', emoji: true } },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: '🧠 *Producer Memory*\nRemembers your projects and history' },
            { type: 'mrkdwn', text: '🎯 *A&R Simulation*\nLabel exec evaluation of your track' },
          ],
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: '✅ *Release Readiness*\nPre-release checklist and guidance' },
            { type: 'mrkdwn', text: '💰 *Beat Marketplace*\nMonetization and SEO advice' },
          ],
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: '🚀 *Career Path Finder*\nPersonalized music career roadmap' },
            { type: 'mrkdwn', text: '📅 *Sprint Planner*\nWeekly production goals and tasks' },
          ],
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: '🔍 *Reference Blueprint*\nFull track analysis and sound guide' },
            { type: 'mrkdwn', text: '🎤 *Artist DNA*\nDeep comparison with Spotify data' },
          ],
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: '🤝 *Collab Mode*\nTeam session tracking and summaries' },
            { type: 'mrkdwn', text: '🎛️ *Audio Analysis*\nUpload MP3/WAV for instant scan' },
          ],
        },
        { type: 'divider' },
        { type: 'header', text: { type: 'plain_text', text: '📊 About Wavmind', emoji: true } },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: '🤖 *AI Engine*\nGroq — Llama 3.1' },
            { type: 'mrkdwn', text: '🎵 *Music Data*\nReal Spotify API' },
          ],
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: '📰 *News*\nNewsData.io Real-Time API' },
            { type: 'mrkdwn', text: '🎧 *Audio*\nLibrosa Python Analysis' },
          ],
        },
        { type: 'divider' },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: '🎛️ *Wavmind* — Built for music producers | Type `/wavmind` to see all commands' }],
        },
      ],
    },
  });
}

app.event('app_home_opened', async ({ event, client }) => {
  try {
    await publishAppHome(client, event.user);
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
        section(`*File:* ${file.name}\nAnalyzing energy, brightness and bass. Takes about 15 seconds...`),
        context('⏳ Please wait'),
      ],
    });

    const analysis = await analyzeAudioFile(file.url_private_download, file.name);

    if (!analysis || analysis.error) {
      await client.chat.postMessage({
        channel: event.channel_id,
        blocks: [
          header('❗ Scan Failed'),
          section(`Could not analyze *${file.name}*.\nTry a smaller file (under 10MB) or MP3 format.`),
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
        section('*🎵 Ready for AI mixing feedback + action plan?*\n\nTell me your BPM and Key from your DAW:'),
        section('```/wavmind mixfeedback bpm:85 key:F_minor```'),
        section('*Key format:* `C_major` · `F_minor` · `G_major` · `A_minor` · `Bb_major`'),
        context('💡 Find BPM and Key in FL Studio, Ableton, Logic or any DAW'),
      ],
    });
  } catch (err) {
    console.error('File handler error:', err.message);
  }
});

// ─── SLASH COMMANDS ───────────────────────────────────────
app.command('/wavmind', async ({ command, ack, respond, client }) => {
  await ack();
  const input = command.text.trim();
  const lower = input.toLowerCase();
  const userId = command.user_id;

  // HELP
  if (!input || lower === 'help') {
    await respond({ response_type: 'ephemeral', blocks: getWelcomeBlocks() });
    return;
  }

  // ─── PROJECT MEMORY ──────────────────────────────────
  if (lower.startsWith('project')) {
    const subInput = input.slice(7).trim();
    const subLower = subInput.toLowerCase();

    if (subLower.startsWith('new')) {
      const name = subInput.slice(3).trim().replace(/['"]/g, '') || 'Untitled Track';
      memory.createProject(userId, name);
      await respond({
        response_type: 'in_channel',
        blocks: [
          header('🧠 Project Created'),
          section(`*Track:* "${name}"\n*Producer:* <@${userId}>`),
          divider(),
          section('Wavmind will remember everything about this project. Update your details:'),
          section('`/wavmind project set bpm:140 key:F_minor genre:trap`\n`/wavmind project ref Blinding Lights - The Weeknd`\n`/wavmind project task Mix the 808s`'),
          divider(),
          context('💡 Your project is now showing on your Wavmind Home tab'),
        ],
      });
      await publishAppHome(client, userId);
      return;
    }

    if (subLower.startsWith('set')) {
      const project = memory.getProject(userId);
      if (!project) {
        await respond({ blocks: [header('❗ No Active Project'), section('Create one first:\n`/wavmind project new "Track Name"`')] });
        return;
      }
      const parts = subInput.slice(3).trim();
      const bpmMatch = parts.match(/bpm[:\s]+(\d+)/i);
      const keyMatch = parts.match(/key[:\s]+([\w#b_]+)/i);
      const genreMatch = parts.match(/genre[:\s]+([^\s]+(?:\s+[^\s]+)*)/i);

      const updates = {};
      if (bpmMatch) updates.bpm = parseInt(bpmMatch[1]);
      if (keyMatch) updates.key = keyMatch[1].replace(/_/g, ' ');
      if (genreMatch) updates.genre = genreMatch[1];

      memory.saveProject(userId, updates);
      const updated = memory.getProject(userId);

      await respond({
        blocks: [
          header('🧠 Project Updated'),
          section(`*Track:* "${updated.name}"`),
          twoCol(`🥁 *BPM*\n${updated.bpm || 'Not set'}`, `🎼 *Key*\n${updated.key || 'Not set'}`),
          twoCol(`🎸 *Genre*\n${updated.genre || 'Not set'}`, `🔍 *References*\n${updated.references.length} saved`),
          context('💡 View your project anytime with `/wavmind project`'),
        ],
      });
      await publishAppHome(client, userId);
      return;
    }

    if (subLower.startsWith('ref')) {
      const project = memory.getProject(userId);
      if (!project) {
        await respond({ blocks: [header('❗ No Active Project'), section('Create one first:\n`/wavmind project new "Track Name"`')] });
        return;
      }
      const ref = subInput.slice(3).trim();
      if (!ref) {
        await respond({ blocks: [header('❗ Missing Reference'), section('*Example:*\n`/wavmind project ref Blinding Lights - The Weeknd`')] });
        return;
      }
      project.references.push(ref);
      memory.saveProject(userId, { references: project.references });
      await respond({
        blocks: [
          header('🔍 Reference Added'),
          section(`*"${ref}"* added to *${project.name}*`),
          context(`📚 ${project.references.length} reference${project.references.length !== 1 ? 's' : ''} saved`),
        ],
      });
      await publishAppHome(client, userId);
      return;
    }

    if (subLower.startsWith('task')) {
      const project = memory.getProject(userId);
      if (!project) {
        await respond({ blocks: [header('❗ No Active Project'), section('Create one first:\n`/wavmind project new "Track Name"`')] });
        return;
      }
      const task = subInput.slice(4).trim();
      if (!task) {
        await respond({ blocks: [header('❗ Missing Task'), section('*Example:*\n`/wavmind project task Mix the 808s`')] });
        return;
      }
      project.tasks.push(task);
      memory.saveProject(userId, { tasks: project.tasks });
      await respond({
        blocks: [
          header('📋 Task Added'),
          section(`*"${task}"* added to *${project.name}*`),
          context(`📋 ${project.tasks.length} task${project.tasks.length !== 1 ? 's' : ''} in project`),
        ],
      });
      await publishAppHome(client, userId);
      return;
    }

    if (subLower.startsWith('clear')) {
      memory.deleteProject(userId);
      await respond({ blocks: [header('🗑️ Project Cleared'), section('Your project has been cleared. Start a new one:\n`/wavmind project new "Track Name"`')] });
      await publishAppHome(client, userId);
      return;
    }

    // VIEW PROJECT
    const project = memory.getProject(userId);
    if (!project) {
      await respond({
        blocks: [
          header('🧠 Producer Memory'),
          section('You have no active project.\n\nStart one:\n`/wavmind project new "Track Name"`'),
          context('Wavmind will remember your BPM, key, references, tasks and feedback history'),
        ],
      });
      return;
    }
    await respond({
      blocks: [
        header('🧠 Your Project'),
        section(`*Track:* "${project.name}"\n*Producer:* <@${userId}>`),
        divider(),
        twoCol(`🥁 *BPM*\n${project.bpm || 'Not set'}`, `🎼 *Key*\n${project.key || 'Not set'}`),
        twoCol(`🎸 *Genre*\n${project.genre || 'Not set'}`, `🔍 *References*\n${project.references.length > 0 ? project.references.join(', ') : 'None saved'}`),
        project.tasks.length > 0 ? section(`*📋 Tasks:*\n${project.tasks.map(t => `• ${t}`).join('\n')}`) : section('*📋 Tasks:* None added yet'),
        divider(),
        context('Update with `/wavmind project set bpm:140 key:F_minor genre:trap` · Add ref with `/wavmind project ref [track name]`'),
      ],
    });
    return;
  }

  // ─── TASK DONE ───────────────────────────────────────
  if (lower.startsWith('task done')) {
    const num = parseInt(input.slice(9).trim()) - 1;
    const plan = memory.getActionPlan(userId);
    if (!plan) {
      await respond({ blocks: [header('❗ No Action Plan'), section('Get mix feedback first to generate an action plan:\n`/wavmind feedback [describe your mix]`')] });
      return;
    }
    memory.completeTask(userId, num);
    const updated = memory.getActionPlan(userId);
    await respond({
      blocks: [
        header('✅ Task Completed'),
        section(updated.items.map((item, i) => updated.completed.includes(i) ? `✅ ~${item}~` : `☐ ${item}`).join('\n')),
        context(`${updated.completed.length}/${updated.items.length} tasks completed`),
      ],
    });
    await publishAppHome(client, userId);
    return;
  }

  // ─── A&R SIMULATION ──────────────────────────────────
  if (lower.startsWith('ar ') || lower === 'ar') {
    const description = input.slice(2).trim();
    if (!description) {
      await respond({
        blocks: [
          header('❗ Missing Track Description'),
          section('*Example:*\n`/wavmind ar Dark trap beat at 140bpm in F minor, heavy 808s, melodic piano loop`'),
        ],
      });
      return;
    }
    await respond({
      blocks: [
        header('🎯 A&R Evaluation in Progress...'),
        section(`_"${description}"_`),
        context('⏳ Label executive AI is reviewing your track...'),
      ],
    });

    const project = memory.getProject(userId);
    const projectContext = project ? `Producer's project context: Track "${project.name}", BPM ${project.bpm || 'unknown'}, Key ${project.key || 'unknown'}, Genre ${project.genre || 'unknown'}.` : '';

    const response = await askAI(
      `You are a senior A&R executive at a major record label with 20 years of experience. Evaluate this track like you would for signing:

Track description: "${description}"
${projectContext}

Give a detailed A&R evaluation covering:
- *Commercial Potential* (1-10 score with explanation)
- *Playlist Potential* (which playlists would this fit)
- *Target Audience* (who is this for)
- *Strengths* (what works well)
- *Weaknesses* (what needs work)
- *Market Positioning* (where does this fit in current market)
- *Verdict* (pass, consider, or strong interest — with reason)

Be honest, specific and professional like a real A&R executive.`
    );

    await respond({
      blocks: [
        header('🎯 A&R Evaluation'),
        section(`*Track:* _${description}_`),
        divider(),
        section(response || 'Could not generate evaluation. Try again!'),
        divider(),
        context('💡 Use `/wavmind release [track description]` to check if you\'re ready to release'),
      ],
    });
    return;
  }

  // ─── RELEASE READINESS ───────────────────────────────
  if (lower.startsWith('release')) {
    const description = input.slice(7).trim();
    if (!description) {
      await respond({
        blocks: [
          header('❗ Missing Track Description'),
          section('*Example:*\n`/wavmind release Trap beat 140bpm F minor, mixed and mastered`'),
        ],
      });
      return;
    }
    await respond({
      blocks: [
        header('✅ Checking Release Readiness...'),
        section(`_"${description}"_`),
        context('⏳ Running pre-release checklist...'),
      ],
    });

    const response = await askAI(
      `You are a professional mastering engineer and music release consultant. Run a complete release readiness check for this track:

Track: "${description}"

Evaluate and give a checklist covering:
- *Mix Quality* — is the mix ready for release
- *Loudness* — target LUFS for streaming platforms
- *Metadata* — what they need (title, ISRC, BPM, key, genre, mood tags)
- *Distribution* — which platforms to use and why
- *Release Strategy* — best day to release, promotional tips
- *Cover Art* — requirements and suggestions
- *Pre-save Campaign* — how to set it up
- *Overall Readiness Score* — X/10 with specific things to fix first

Format as a clear checklist with ✅ or ⚠️ for each item.`
    );

    await respond({
      blocks: [
        header('✅ Release Readiness Report'),
        section(`*Track:* _${description}_`),
        divider(),
        section(response || 'Could not generate checklist. Try again!'),
        divider(),
        context('💡 Use `/wavmind ar [description]` to get an A&R evaluation before releasing'),
      ],
    });
    return;
  }

  // ─── BEAT MARKETPLACE ADVISOR ────────────────────────
  if (lower.startsWith('marketplace')) {
    const description = input.slice(11).trim();
    if (!description) {
      await respond({
        blocks: [
          header('❗ Missing Track Details'),
          section('*Example:*\n`/wavmind marketplace dark trap 140bpm F minor`'),
        ],
      });
      return;
    }
    await respond({
      blocks: [
        header('💰 Generating Marketplace Strategy...'),
        section(`*Track:* ${description}`),
        context('⏳ Analyzing market positioning...'),
      ],
    });

    const response = await askAI(
      `You are an expert beat marketplace consultant who has helped producers make millions selling beats online. Create a complete marketplace strategy for this beat:

Beat: "${description}"

Provide:
- *BeatStars Title* — SEO optimized title (include artist name, mood, BPM, key)
- *Tags* — 20 specific tags for maximum discoverability
- *Description* — compelling beat description for buyers
- *YouTube Title* — optimized for YouTube search
- *YouTube Description* — full description with timestamps and keywords
- *Price Points* — MP3 lease, WAV lease, trackout, exclusive
- *Target Artists* — which type of artists to pitch this to
- *Marketing Strategy* — how to promote this beat
- *Similar Beats* — reference successful beats in this style

Be specific with real examples and current market rates.`
    );

    await respond({
      blocks: [
        header('💰 Marketplace Strategy'),
        section(`*Beat:* ${description}`),
        divider(),
        section(response || 'Could not generate strategy. Try again!'),
        divider(),
        context('💡 Use `/wavmind ar [description]` to evaluate commercial potential before listing'),
      ],
    });
    return;
  }

  // ─── CAREER PATH FINDER ──────────────────────────────
  if (lower.startsWith('career')) {
    const details = input.slice(6).trim();
    await respond({
      blocks: [
        header('🚀 Analyzing Your Career Path...'),
        context('⏳ Building your personalized music industry roadmap...'),
      ],
    });

    const project = memory.getProject(userId);
    const projectContext = project ? `Their current project: ${project.name}, Genre: ${project.genre || 'unknown'}.` : '';

    const response = await askAI(
      `You are a music industry career coach who has worked with Grammy-winning producers. ${details ? `This producer told you: "${details}".` : 'Create a general music career assessment.'} ${projectContext}

Create a comprehensive career path analysis covering:

- *Career Path Options:*
  - Producer
  - Mixing Engineer  
  - Mastering Engineer
  - Sound Designer
  - Film/TV Composer
  - Sample Pack Creator
  - Beat Marketplace Seller

For the top 3 most suitable paths give:
- *Why this path fits them*
- *Skills to develop*
- *Tools to learn*
- *Income potential*
- *First 3 steps to take this week*
- *Portfolio strategy*
- *Key platforms to build presence on*

End with one bold recommendation.`
    );

    await respond({
      blocks: [
        header('🚀 Your Music Career Roadmap'),
        divider(),
        section(response || 'Could not generate roadmap. Try again!'),
        divider(),
        context('💡 Use `/wavmind sprint [goal]` to create a weekly plan to start your career path'),
      ],
    });
    return;
  }

  // ─── PRODUCTION SPRINT PLANNER ───────────────────────
  if (lower.startsWith('sprint')) {
    const goal = input.slice(6).trim();
    if (!goal) {
      await respond({
        blocks: [
          header('❗ Missing Goal'),
          section('*Example:*\n`/wavmind sprint Finish my trap EP this week`\n`/wavmind sprint Release my first beat on BeatStars`'),
        ],
      });
      return;
    }
    await respond({
      blocks: [
        header('📅 Creating Your Production Sprint...'),
        section(`*Goal:* ${goal}`),
        context('⏳ Building your weekly plan...'),
      ],
    });

    const response = await askAI(
      `You are a music production project manager. Create a detailed 7-day production sprint for this goal:

Goal: "${goal}"

Create a day-by-day plan:
- *Day 1* — specific tasks
- *Day 2* — specific tasks
- *Day 3* — specific tasks
- *Day 4* — specific tasks
- *Day 5* — specific tasks
- *Day 6* — specific tasks
- *Day 7* — review and release/submit

For each day give 2-3 specific actionable tasks. End with success metrics — how will they know they achieved the goal?

Be realistic about time and specific about what to do.`
    );

    const tasks = [
      'Day 1 tasks',
      'Day 2 tasks',
      'Day 3 tasks',
      'Day 4 tasks',
      'Day 5 tasks',
      'Day 6 tasks',
      'Day 7 review',
    ];

    memory.saveSprintPlan(userId, { goal, tasks: tasks, fullPlan: response });

    await respond({
      response_type: 'in_channel',
      blocks: [
        header('📅 Production Sprint Created'),
        section(`*Goal:* ${goal}`),
        divider(),
        section(response || 'Could not generate plan. Try again!'),
        divider(),
        context('💡 Your sprint is now showing on your Wavmind Home tab · Use `/wavmind project task [task]` to log progress'),
      ],
    });
    await publishAppHome(client, userId);
    return;
  }

  // ─── COLLAB MODE ─────────────────────────────────────
  if (lower.startsWith('collab')) {
    const subInput = input.slice(6).trim();
    const subLower = subInput.toLowerCase();

    if (subLower.startsWith('start')) {
      const trackName = subInput.slice(5).trim().replace(/['"]/g, '') || 'Untitled Track';
      const existing = getCollabSession(command.channel_id);
      if (existing) {
        await respond({ blocks: [header('⚠️ Session Already Active'), section(`Session for *"${existing.trackName}"* is running.\n\`/wavmind collab summary\` or \`/wavmind collab end\``)] });
        return;
      }
      startCollabSession(command.channel_id, trackName, userId);
      await respond({
        response_type: 'in_channel',
        blocks: [
          header('🤝 Collab Session Started'),
          section(`*Track:* "${trackName}"\n*Started by:* <@${userId}>`),
          divider(),
          twoCol('💡 *Log idea*\n`/wavmind collab idea [idea]`', '🎚️ *Log feedback*\n`/wavmind collab feedback [feedback]`'),
          twoCol('✅ *Log decision*\n`/wavmind collab decision [decision]`', '📋 *Get summary*\n`/wavmind collab summary`'),
          divider(),
          context(`🤝 Session active for "${trackName}" · /wavmind collab end to finish`),
        ],
      });
      return;
    }

    if (subLower.startsWith('idea')) {
      const idea = subInput.slice(4).trim();
      const session = getCollabSession(command.channel_id);
      if (!session) { await respond({ blocks: [header('❗ No Active Session'), section('`/wavmind collab start "Track Name"`')] }); return; }
      if (!idea) { await respond({ blocks: [header('❗ Missing Idea'), section('`/wavmind collab idea [your idea]`')] }); return; }
      session.ideas.push({ text: idea, user: userId, time: new Date().toISOString() });
      await respond({ response_type: 'in_channel', blocks: [header('💡 Idea Logged'), section(`*"${idea}"*\n— <@${userId}>`), context(`💡 ${session.ideas.length} idea${session.ideas.length !== 1 ? 's' : ''} for "${session.trackName}"`)] });
      return;
    }

    if (subLower.startsWith('feedback')) {
      const fb = subInput.slice(8).trim();
      const session = getCollabSession(command.channel_id);
      if (!session) { await respond({ blocks: [header('❗ No Active Session'), section('`/wavmind collab start "Track Name"`')] }); return; }
      if (!fb) { await respond({ blocks: [header('❗ Missing Feedback'), section('`/wavmind collab feedback [your feedback]`')] }); return; }
      session.feedback.push({ text: fb, user: userId, time: new Date().toISOString() });
      await respond({ response_type: 'in_channel', blocks: [header('🎚️ Feedback Logged'), section(`*"${fb}"*\n— <@${userId}>`), context(`🎚️ ${session.feedback.length} feedback items for "${session.trackName}"`)] });
      return;
    }

    if (subLower.startsWith('decision')) {
      const dec = subInput.slice(8).trim();
      const session = getCollabSession(command.channel_id);
      if (!session) { await respond({ blocks: [header('❗ No Active Session'), section('`/wavmind collab start "Track Name"`')] }); return; }
      if (!dec) { await respond({ blocks: [header('❗ Missing Decision'), section('`/wavmind collab decision [your decision]`')] }); return; }
      session.decisions.push({ text: dec, user: userId, time: new Date().toISOString() });
      await respond({ response_type: 'in_channel', blocks: [header('✅ Decision Logged'), section(`*"${dec}"*\n— <@${userId}>`), context(`✅ ${session.decisions.length} decisions for "${session.trackName}"`)] });
      return;
    }

    if (subLower.startsWith('status')) {
      const session = getCollabSession(command.channel_id);
      if (!session) { await respond({ blocks: [header('❗ No Active Session'), section('`/wavmind collab start "Track Name"`')] }); return; }
      await respond({ blocks: [header('📊 Session Status'), section(`*Track:* "${session.trackName}"\n*Started by:* <@${session.startedBy}>`), divider(), twoCol(`💡 *Ideas*\n${session.ideas.length}`, `🎚️ *Feedback*\n${session.feedback.length}`), twoCol(`✅ *Decisions*\n${session.decisions.length}`, `⏱️ *Started*\n${new Date(session.startedAt).toLocaleTimeString()}`), context('`/wavmind collab summary` or `/wavmind collab end`')] });
      return;
    }

    if (subLower.startsWith('summary')) {
      const session = getCollabSession(command.channel_id);
      if (!session) { await respond({ blocks: [header('❗ No Active Session'), section('`/wavmind collab start "Track Name"`')] }); return; }
      await respond({ blocks: [header('📋 Generating Summary...'), context('⏳ AI reviewing session...')] });
      const summary = await askAI(`Summarize this music collab session for "${session.trackName}":
IDEAS: ${session.ideas.map(i => i.text).join(', ') || 'None'}
FEEDBACK: ${session.feedback.map(f => f.text).join(', ') || 'None'}
DECISIONS: ${session.decisions.map(d => d.text).join(', ') || 'None'}
Give: overview, key directions, issues, decisions, next steps. Format with emojis.`);
      await respond({ response_type: 'in_channel', blocks: [header('📋 Session Summary'), section(`*Track:* "${session.trackName}"`), divider(), twoCol(`💡 *Ideas*\n${session.ideas.length}`, `🎚️ *Feedback*\n${session.feedback.length}`), twoCol(`✅ *Decisions*\n${session.decisions.length}`, `⏱️ *Started*\n${new Date(session.startedAt).toLocaleTimeString()}`), divider(), section(summary || 'Could not generate. Try again!'), context('`/wavmind collab end` to finish')] });
      return;
    }

    if (subLower.startsWith('end')) {
      const session = getCollabSession(command.channel_id);
      if (!session) { await respond({ blocks: [header('❗ No Active Session'), section('No active session in this channel.')] }); return; }
      await respond({ blocks: [header('📋 Generating Final Report...'), context('⏳ Creating report...')] });
      const finalSummary = await askAI(`Create a final session report for "${session.trackName}":
IDEAS: ${session.ideas.map(i => i.text).join(', ') || 'None'}
FEEDBACK: ${session.feedback.map(f => f.text).join(', ') || 'None'}
DECISIONS: ${session.decisions.map(d => d.text).join(', ') || 'None'}
Write: overview, creative direction, technical decisions, action items, closing note. Format professionally.`);
      endCollabSession(command.channel_id);
      await respond({ response_type: 'in_channel', blocks: [header('🏁 Collab Session Complete'), section(`*Track:* "${session.trackName}"\n*Started by:* <@${session.startedBy}>`), divider(), twoCol(`💡 *Ideas*\n${session.ideas.length}`, `🎚️ *Feedback*\n${session.feedback.length}`), twoCol(`✅ *Decisions*\n${session.decisions.length}`, `⏱️ *Started*\n${new Date(session.startedAt).toLocaleTimeString()}`), divider(), section(finalSummary || 'Could not generate. Try again!'), context('Start new session: `/wavmind collab start "Track Name"`')] });
      return;
    }

    await respond({ blocks: [header('🤝 Collab Mode'), section('`/wavmind collab start "Track Name"` — Start\n`/wavmind collab idea [idea]` — Log idea\n`/wavmind collab feedback [feedback]` — Log feedback\n`/wavmind collab decision [decision]` — Log decision\n`/wavmind collab summary` — Get summary\n`/wavmind collab end` — End session')] });
    return;
  }

  // ─── TRENDING ────────────────────────────────────────
  if (lower.startsWith('trending')) {
    const topic = input.slice(8).trim() || 'music production';
    await respond({ blocks: [header('📰 Fetching Music News...'), section(`Searching real-time news for *${topic}*`), context('⏳ Scanning music industry...')] });

    const articles = await getTrendingMusic(topic);
    if (!articles || articles.length === 0) {
      await respond({ blocks: [header('❗ No Results'), section(`No news found for *${topic}*.\nTry: \`/wavmind trending trap\` or \`/wavmind trending plugins\``)] });
      return;
    }

    const newsText = articles.map((a, i) => `${i + 1}. *${a.title}*\n_${a.source} · ${a.date}_${a.description ? '\n' + a.description : ''}`).join('\n\n');
    const aiSummary = await askAI(`You are Wavmind. Based on these music news articles about "${topic}":
${articles.map(a => `- ${a.title}: ${a.description}`).join('\n')}
Tell producers: what this means for music production right now, key trends, how to use these trends, any new tools mentioned. Be specific and actionable.`);

    await respond({
      blocks: [
        header('📰 Music Industry News'),
        section(`*Topic:* ${topic}`),
        divider(),
        section('🔴 *Latest News (Real-Time)*'),
        section(newsText),
        divider(),
        section('🎛️ *What This Means for Producers:*'),
        section(aiSummary || 'Could not generate insights.'),
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
      await respond({ blocks: [header('❗ Need Two Artists'), section('`/wavmind compare Drake and Travis Scott`\n`/wavmind compare Drake vs Travis Scott`')] });
      return;
    }
    await respond({ blocks: [header('🔍 Comparing Artists...'), section(`Looking up *${artists}* on Spotify`), context('⏳ Fetching data...')] });

    let artist1, artist2;
    if (artists.toLowerCase().includes(' and ')) {
      [artist1, artist2] = artists.split(/\s+and\s+/i).map(s => s.trim());
    } else if (artists.toLowerCase().includes(' vs ')) {
      [artist1, artist2] = artists.split(/\s+vs\s+/i).map(s => s.trim());
    } else {
      const words = artists.split(' ');
      const mid = Math.ceil(words.length / 2);
      artist1 = words.slice(0, mid).join(' ');
      artist2 = words.slice(mid).join(' ');
    }

    const [stats1, stats2] = await Promise.all([getArtistStats(artist1), getArtistStats(artist2)]);
    if (!stats1 || !stats2) {
      await respond({ blocks: [header('❗ Artist Not Found'), section('Could not find one or both artists.\nTry: `/wavmind compare Drake and Travis Scott`')] });
      return;
    }

    const aiComparison = await askAI(`Compare production styles of these artists based on Spotify data:
${stats1.name}: BPM ${stats1.bpm}, Energy ${stats1.energy}%, Danceability ${stats1.danceability}%, Valence ${stats1.valence}%, Loudness ${stats1.loudness}dB, Key ${stats1.key}
${stats2.name}: BPM ${stats2.bpm}, Energy ${stats2.energy}%, Danceability ${stats2.danceability}%, Valence ${stats2.valence}%, Loudness ${stats2.loudness}dB, Key ${stats2.key}
Give: key production differences, what makes each unique, how to blend both styles, which genres each suits. Be specific.`);

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
        { type: 'section', fields: [{ type: 'mrkdwn', text: `🎵 *Key*\n${stats1.key}` }, { type: 'mrkdwn', text: `🎵 *Key*\n${stats2.key}` }] },
        divider(),
        section('🎛️ *Production Style Analysis:*'),
        section(aiComparison || 'Could not generate comparison.'),
        divider(),
        context('💡 `/wavmind reference [track]` to analyze a specific song'),
      ],
    });
    return;
  }

  // ─── IDEAS ───────────────────────────────────────────
  if (lower.startsWith('ideas')) {
    const genre = input.slice(5).trim() || 'general';
    await respond({ blocks: [header('🎵 Generating Production Concept...'), section(`*Genre/Mood:* ${genre}`), context('⏳ Creating full concept...')] });
    const project = memory.getProject(userId);
    const ctx = project ? `Producer's current project: "${project.name}", BPM ${project.bpm || 'unknown'}, Key ${project.key || 'unknown'}.` : '';
    const response = await askAI(`You are Wavmind, expert music producer. ${ctx} Generate a complete production concept for: "${genre}".

For each of 3 track ideas provide:
🎵 *Title* — concept
- BPM: [number]
- Key: [key]
- Instruments: [list]
- Mood: [mood]
- Arrangement: [verse/chorus structure]
- Sound design direction: [specific sounds]

Be specific and inspiring.`);
    await respond({ blocks: [header('🎵 Production Concepts'), section(`*Genre/Mood:* ${genre}`), divider(), section(response || 'Could not generate. Try again!'), divider(), context('💡 `/wavmind project set bpm:140 key:F_minor` to save your chosen direction')] });
    return;
  }

  // ─── FEEDBACK + ACTION PLAN ──────────────────────────
  if (lower.startsWith('feedback')) {
    const description = input.slice(8).trim();
    if (!description) {
      await respond({ blocks: [header('❗ Missing Description'), section('*Example:*\n`/wavmind feedback My trap beat at 140bpm feels muddy in the low end`')] });
      return;
    }
    await respond({ blocks: [header('🎚️ Analyzing Mix + Creating Action Plan...'), section(`_"${description}"_`), context('⏳ Generating professional feedback...')] });

    const project = memory.getProject(userId);
    const ctx = project ? `Producer's project: "${project.name}", BPM ${project.bpm || 'unknown'}, Key ${project.key || 'unknown'}.` : '';

    const response = await askAI(`You are Wavmind, professional mixing engineer. ${ctx} Give detailed mixing feedback for: "${description}".

Cover: EQ issues, compression, stereo width, frequency balance, arrangement. Then create a numbered action plan of specific tasks to fix the issues. Format: feedback first, then *Action Plan:* with numbered items.`);

    // Extract action items
    const actionMatch = response?.split(/action plan:/i);
    const feedbackText = actionMatch?.[0] || response;
    const actionText = actionMatch?.[1] || '';
    const actionItems = actionText.split('\n').filter(l => l.match(/^\d+\.|^•/)).map(l => l.replace(/^\d+\.|^•/, '').trim()).filter(Boolean);

    if (actionItems.length > 0) {
      memory.saveActionPlan(userId, actionItems);
    }

    await respond({
      blocks: [
        header('🎚️ Mix Feedback'),
        section(`*Your mix:* _${description}_`),
        divider(),
        section(feedbackText || response || 'Could not analyze.'),
        actionItems.length > 0 ? divider() : { type: 'section', text: { type: 'mrkdwn', text: '' } },
        actionItems.length > 0 ? header('📋 Action Plan') : { type: 'section', text: { type: 'mrkdwn', text: '' } },
        actionItems.length > 0 ? section(actionItems.map((item, i) => `${i + 1}. ${item}`).join('\n')) : { type: 'section', text: { type: 'mrkdwn', text: '' } },
        divider(),
        context('💡 Mark tasks done with `/wavmind task done [number]` · View on Home tab'),
      ].filter(b => b.text?.text !== ''),
    });

    if (project) {
      project.feedbackHistory.push({ description, time: new Date().toISOString() });
      memory.saveProject(userId, { feedbackHistory: project.feedbackHistory });
    }
    await publishAppHome(client, userId);
    return;
  }

  // ─── MIXFEEDBACK ─────────────────────────────────────
  if (lower.startsWith('mixfeedback')) {
    const parts = input.slice(11).trim();
    const bpmMatch = parts.match(/bpm[:\s]+(\d+)/i);
    const keyMatch = parts.match(/key[:\s]+([\w#b_]+)/i);
    if (!bpmMatch || !keyMatch) {
      await respond({ blocks: [header('❗ Missing BPM or Key'), section('*Format:*\n`/wavmind mixfeedback bpm:140 key:F_minor`\n\n*Key examples:*\n`C_major` · `F_minor` · `G_major` · `A_minor`'), context('💡 Find in your DAW')] });
      return;
    }
    const bpm = parseInt(bpmMatch[1]);
    const key = keyMatch[1].replace(/_/g, ' ');
    const stored = global.pendingAnalysis?.[command.channel_id];
    await respond({ blocks: [header('🎚️ Generating Mix Feedback + Action Plan...'), twoCol(`🥁 *BPM*\n${bpm}`, `🎵 *Key*\n${key}`), context('⏳ Analyzing...')] });

    const contextInfo = stored ? `Energy: ${stored.energy}%, Brightness: ${stored.brightness}, Bass: ${stored.bass_ratio}%` : '';
    const response = await askAI(`You are Wavmind, professional mixing engineer. Track: BPM ${bpm}, Key ${key}. ${contextInfo}

Give specific professional mixing feedback then create a numbered *Action Plan:* with specific tasks to improve this mix. Use real plugin names.`);

    const actionMatch = response?.split(/action plan:/i);
    const feedbackText = actionMatch?.[0] || response;
    const actionItems = actionMatch?.[1]?.split('\n').filter(l => l.match(/^\d+\.|^•/)).map(l => l.replace(/^\d+\.|^•/, '').trim()).filter(Boolean) || [];

    if (actionItems.length > 0) memory.saveActionPlan(userId, actionItems);
    if (global.pendingAnalysis?.[command.channel_id]) delete global.pendingAnalysis[command.channel_id];

    await respond({
      blocks: [
        header('🎛️ Mix Feedback + Action Plan'),
        twoCol(`🥁 *BPM*\n${bpm}`, `🎵 *Key*\n${key}`),
        stored ? twoCol(`⚡ *Energy*\n${stored.energy}%`, `🔊 *Bass*\n${stored.bass_ratio}%`) : divider(),
        divider(),
        section(feedbackText || 'Could not generate.'),
        actionItems.length > 0 ? section(`*📋 Action Plan:*\n${actionItems.map((item, i) => `${i + 1}. ${item}`).join('\n')}`) : divider(),
        divider(),
        context('💡 Mark tasks done: `/wavmind task done [number]` · View on Home tab'),
      ],
    });
    await publishAppHome(client, userId);
    return;
  }

  // ─── REFERENCE ───────────────────────────────────────
  if (lower.startsWith('reference')) {
    const trackQuery = input.slice(9).trim();
    if (!trackQuery) {
      await respond({ blocks: [header('❗ Missing Track'), section('`/wavmind reference Blinding Lights - The Weeknd`')] });
      return;
    }
    await respond({ blocks: [header('🔍 Building Reference Blueprint...'), section(`Analyzing *${trackQuery}*`), context('⏳ Fetching Spotify data...')] });

    const features = await getTrackFeatures(trackQuery);
    if (features) {
      const project = memory.getProject(userId);
      const response = await askAI(`You are Wavmind, professional mixing engineer. Create a complete blueprint for achieving the sound of:
Track: ${features.name} by ${features.artist}
BPM: ${features.bpm}, Key: ${features.key}, Energy: ${features.energy}%, Danceability: ${features.danceability}%, Loudness: ${features.loudness}dB, Valence: ${features.valence}%
${project ? `Producer's track is: "${project.name}", BPM ${project.bpm}, Key ${project.key}` : ''}

Cover: tempo and groove, key and harmony, drum pattern, bass approach, melody, mixing targets, specific plugins and techniques, energy curve throughout the song.`);

      if (project) {
        project.references.push(`${features.name} - ${features.artist}`);
        memory.saveProject(userId, { references: project.references });
        await publishAppHome(client, userId);
      }

      await respond({
        blocks: [
          header('🔍 Reference Blueprint'),
          section(`*${features.name}* by *${features.artist}*`),
          divider(),
          section('📊 *Real Spotify Data*'),
          twoCol(`🥁 *BPM*\n${features.bpm}`, `🎵 *Key*\n${features.key}`),
          twoCol(`⚡ *Energy*\n${features.energy}%`, `💃 *Danceability*\n${features.danceability}%`),
          twoCol(`🔊 *Loudness*\n${features.loudness} dB`, `😊 *Valence*\n${features.valence}%`),
          divider(),
          section('🎛️ *Production Blueprint:*'),
          section(response || 'Could not generate blueprint.'),
          divider(),
          context(project ? `✅ Reference saved to your project "${project.name}"` : '💡 `/wavmind project new "Track Name"` to save this reference'),
        ],
      });
    } else {
      const response = await askAI(`Create a production blueprint for achieving the sound of "${trackQuery}". Cover: tempo, key, drums, bass, melody, mix approach.`);
      await respond({ blocks: [header('🔍 Reference Blueprint'), section(`*Track:* ${trackQuery}`), divider(), section(response || 'Could not generate.'), context('💡 Include artist name for better results')] });
    }
    return;
  }

  // ─── BPM ─────────────────────────────────────────────
  if (lower.startsWith('bpm')) {
    const mood = input.slice(3).trim() || 'general';
    await respond({ blocks: [header('🥁 BPM & Key Suggestions'), section(`*Genre/Mood:* ${mood}`), context('⏳ Calculating...')] });
    const response = await askAI(`You are Wavmind. For "${mood}" suggest: ideal BPM range, best keys, chord progressions, typical song structure. Be specific with numbers.`);
    await respond({ blocks: [header('🥁 BPM & Key Suggestions'), section(`*Genre/Mood:* ${mood}`), divider(), section(response || 'Could not generate.'), divider(), context('💡 `/wavmind chords [key + genre]` for chord progressions')] });
    return;
  }

  // ─── CHORDS ──────────────────────────────────────────
  if (lower.startsWith('chords')) {
    const query = input.slice(6).trim() || 'C minor trap';
    await respond({ blocks: [header('🎹 Generating Chord Progressions...'), section(`*Query:* ${query}`), context('⏳ Applying music theory...')] });
    const response = await askAI(`You are Wavmind music theory AI. Generate 3 chord progressions for: "${query}". For each: chord names, Roman numeral analysis, emotional feel, suggested melody note.`);
    await respond({ blocks: [header('🎹 Chord Progressions'), section(`*Query:* ${query}`), divider(), section(response || 'Could not generate.'), divider(), context('💡 `/wavmind bpm [genre]` to find ideal tempo')] });
    return;
  }

  // ─── TIPS ────────────────────────────────────────────
  if (lower.startsWith('tips')) {
    const topic = input.slice(4).trim() || 'music production';
    await respond({ blocks: [header('💡 Production Tips'), section(`*Topic:* ${topic}`), context('⏳ Loading expert knowledge...')] });
    const response = await askAI(`You are Wavmind. Give 5 professional actionable tips about "${topic}". Use real techniques and plugin names. Format with emojis and bold titles.`);
    await respond({ blocks: [header('💡 Production Tips'), section(`*Topic:* ${topic}`), divider(), section(response || 'Could not generate.'), divider(), context('💡 `/wavmind feedback [describe mix]` for personalized advice')] });
    return;
  }

  // ─── GENERAL ─────────────────────────────────────────
  await respond({ blocks: [header('🤔 Thinking...'), context('⏳ Processing...')] });
  const response = await askAI(`You are Wavmind, expert AI for music producers. Answer professionally: "${input}"`);
  await respond({ blocks: [header('🎛️ Wavmind'), section(response || 'Could not respond.'), divider(), context('💡 Type `/wavmind` to see all commands')] });
});

// ─── APP MENTION ──────────────────────────────────────────
app.event('app_mention', async ({ event, say }) => {
  const input = event.text.replace(/<@[^>]+>/g, '').trim();
  if (!input) { await say({ blocks: getWelcomeBlocks() }); return; }
  const response = await askAI(`You are Wavmind, expert AI for music producers. Answer: "${input}"`);
  await say({ blocks: [section(`<@${event.user}>`), section(response || 'Could not respond.'), divider(), context('💡 Type `/wavmind` to see all commands')] });
});

// ─── DM HANDLER ───────────────────────────────────────────
app.message(async ({ message, say }) => {
  if (message.subtype) return;
  if (!message.text) return;
  const lower = message.text.toLowerCase().trim();
  if (['hi','hello','hey','start','help'].includes(lower)) { await say({ blocks: getWelcomeBlocks() }); return; }
  const response = await askAI(`You are Wavmind, expert AI for music producers. Answer: "${message.text}"`);
  await say({ blocks: [section(response || 'Could not respond.'), divider(), context('💡 Type `/wavmind` to see all commands')] });
});

// ─── START ────────────────────────────────────────────────
(async () => {
  await app.start();
  console.log('🎛️ Wavmind Agent is running!');
})();
