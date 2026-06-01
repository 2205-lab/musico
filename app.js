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
        { role: 'system', content: 'You are Wavmind, an expert AI assistant for music producers. Format using Slack mrkdwn only. Use *text* for bold. Use _text_ for italic. Use • for bullets. Never use ** or # headers. Keep clean and scannable.' },
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

// ─── NEWSDATA ─────────────────────────────────────────────
async function getTrendingMusic(topic = 'music production') {
  try {
    const url = `https://newsdata.io/api/1/news?apikey=${process.env.NEWSDATA_API_KEY}&q=${encodeURIComponent(topic + ' music producer DAW plugin')}&language=en&category=entertainment,technology`;
    const res = await axios.get(url, { timeout: 10000 });
    const articles = res.data.results?.slice(0, 5) || [];
    if (!articles.length) return null;
    return articles.map(a => ({ title: a.title, source: a.source_id, date: a.pubDate?.split(' ')[0] || 'recent', description: a.description?.slice(0, 150) || '' }));
  } catch (err) { console.error('NewsData error:', err.message); return null; }
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

// ─── UI HELPERS ──────────────────────────────────────────
const divider = () => ({ type: 'divider' });
const header = (text) => ({ type: 'header', text: { type: 'plain_text', text, emoji: true } });
const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });
const twoCol = (l, r) => ({ type: 'section', fields: [{ type: 'mrkdwn', text: l }, { type: 'mrkdwn', text: r }] });
const context = (text) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

function progressBar(percent) {
  const filled = Math.round(percent / 10);
  const empty = 10 - filled;
  return '🟢'.repeat(filled) + '⚪'.repeat(empty) + ` ${percent}%`;
}

function healthEmoji(score) {
  if (score >= 80) return '🟢';
  if (score >= 50) return '🟡';
  return '🔴';
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const diff = new Date(dateStr) - new Date();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function actionButton(text, actionId, value, style) {
  const btn = {
    type: 'button',
    text: { type: 'plain_text', text, emoji: true },
    action_id: actionId,
    value: value || actionId,
  };
  if (style) btn.style = style;
  return btn;
}

function buttonRow(buttons) {
  return {
    type: 'actions',
    elements: buttons,
  };
}

// ─── COLLAB MODE ─────────────────────────────────────────
global.collabSessions = global.collabSessions || {};
const getCollabSession = (id) => global.collabSessions[id] || null;
const startCollabSession = (channelId, trackName, userId) => {
  global.collabSessions[channelId] = { trackName, startedBy: userId, startedAt: new Date().toISOString(), ideas: [], feedback: [], decisions: [] };
  return global.collabSessions[channelId];
};
const endCollabSession = (id) => { const s = global.collabSessions[id]; delete global.collabSessions[id]; return s; };

// ─── HEALTH SCORE BLOCKS ─────────────────────────────────
function getHealthBlocks(userId) {
  const health = memory.calculateHealthScore(userId);
  if (!health) return [header('❗ No Active Project'), section('Create one first:\n`/wavmind project new "Track Name"`')];

  const project = memory.getProject(userId);
  const daysLeft = daysUntil(project.deadline);

  const blocks = [
    header(`${healthEmoji(health.score)} Project Health Score`),
    section(`*${project.name}*`),
    divider(),
    section(`*Overall Health*\n${progressBar(health.score)}`),
  ];

  if (daysLeft !== null) {
    blocks.push(section(daysLeft <= 3 ? `🔴 *Release in ${daysLeft} days — URGENT*` : daysLeft <= 7 ? `🟡 *Release in ${daysLeft} days — attention needed*` : `🟢 *Release in ${daysLeft} days*`));
  }

  blocks.push(divider());

  // Categories
  const categories = {
    'Project Setup': health.checks.projectSetup,
    'Production Planning': health.checks.productionPlanning,
    'Creative Direction': health.checks.creativeDirection,
    'Audio Development': health.checks.audioDevelopment,
    'Release Readiness': health.checks.releaseReadiness,
  };

  for (const [catName, items] of Object.entries(categories)) {
    const itemList = Object.values(items);
    const done = itemList.filter(i => i.done).length;
    const total = itemList.length;
    const catPercent = Math.round((done / total) * 100);
    blocks.push(section(`*${catName}* — ${done}/${total}\n${itemList.map(i => i.done ? `✅ ${i.label}` : `⚠️ ${i.label}`).join('\n')}`));
  }

  // Recommended next step
  const missing = health.allChecks.filter(c => !c.done);
  if (missing.length > 0) {
    blocks.push(divider());
    blocks.push(section(`*🎯 Recommended Next Step:*\n${missing[0].label}`));
  }

  return blocks;
}

// ─── APP HOME DASHBOARD ──────────────────────────────────
async function publishAppHome(client, userId) {
  const project = memory.getProject(userId);
  const actionPlan = memory.getActionPlan(userId);
  const sprint = memory.getSprintPlan(userId);
  const health = project ? memory.calculateHealthScore(userId) : null;

  const blocks = [
    section('*🎛️ Wavmind*\n_Your Autonomous AI Producer Agent_'),
  ];

  if (project) {
    const daysLeft = daysUntil(project.deadline);

    blocks.push(
      divider(),
      header('🎵 Current Project'),
      twoCol(
        `🎵 *Track*\n${project.name}`,
        `🎯 *Health*\n${health ? progressBar(health.score) : 'Not calculated'}`
      ),
      twoCol(
        `🥁 *BPM*\n${project.bpm || '_Not set_'}`,
        `🎼 *Key*\n${project.key || '_Not set_'}`
      ),
      twoCol(
        `🎸 *Genre*\n${project.genre || '_Not set_'}`,
        `📅 *Release*\n${daysLeft !== null ? (daysLeft <= 3 ? `🔴 ${daysLeft} days` : daysLeft <= 7 ? `🟡 ${daysLeft} days` : `🟢 ${daysLeft} days`) : '_No deadline_'}`
      ),
    );

    if (project.references.length > 0) {
      blocks.push(section(`🔍 *References:* ${project.references.slice(0, 3).join(' · ')}`));
    }

    blocks.push(
      buttonRow([
        actionButton('📊 Health Score', 'btn_health', 'health', 'primary'),
        actionButton('🎚️ Analyze Mix', 'btn_feedback', 'feedback'),
        actionButton('🎯 A&R Evaluate', 'btn_ar', 'ar'),
      ])
    );
  } else {
    blocks.push(
      divider(),
      section('🎵 *No active project*\nStart your music production journey:'),
      section('`/wavmind project new "Track Name"`'),
    );
  }

  // Action Plan
  if (actionPlan && actionPlan.items.length > 0) {
    const done = actionPlan.completed.length;
    const total = actionPlan.items.length;
    const pct = Math.round((done / total) * 100);
    blocks.push(
      divider(),
      header('📋 Action Plan'),
      section(`${progressBar(pct)}\n\n${actionPlan.items.slice(0, 5).map((item, i) => actionPlan.completed.includes(i) ? `✅ ~${item}~` : `☐ ${item}`).join('\n')}`),
      context(`${done}/${total} tasks · \`/wavmind task done [number]\` to mark complete`),
    );
  }

  // Sprint
  if (sprint) {
    const done = sprint.completed.length;
    const total = sprint.tasks.length;
    const pct = Math.round((done / total) * 100);
    blocks.push(
      divider(),
      header('🚀 Production Sprint'),
      section(`*Goal:* ${sprint.goal}\n${progressBar(pct)}\n\n${sprint.tasks.slice(0, 5).map((t, i) => sprint.completed.includes(i) ? `✅ ~${t}~` : `☐ ${t}`).join('\n')}`),
      context(`${done}/${total} tasks · Created ${new Date(sprint.createdAt).toLocaleDateString()}`),
    );
  }

  // Deadline alert
  if (project?.deadline) {
    const daysLeft = daysUntil(project.deadline);
    if (daysLeft !== null && daysLeft <= 7) {
      const missingItems = health?.allChecks.filter(c => !c.done) || [];
      blocks.push(
        divider(),
        header(daysLeft <= 3 ? '🔴 Release Risk Alert' : '⚠️ Release Countdown'),
        section(`*${project.name}*\n*Release:* ${project.deadline}\n*Days Remaining:* ${daysLeft}`),
        missingItems.length > 0 ? section(`*Missing:*\n${missingItems.slice(0, 4).map(i => `⚠️ ${i.label}`).join('\n')}`) : section('✅ All items ready!'),
      );
    }
  }

  // Quick commands
  blocks.push(
    divider(),
    header('🚀 Quick Commands'),
    section('`/wavmind project new "Name"` — Start project\n`/wavmind health` — Health score dashboard\n`/wavmind ideas dark trap` — Production concept\n`/wavmind reference [track]` — Track blueprint\n`/wavmind compare [artist] and [artist]` — Artist DNA\n`/wavmind ar [description]` — A&R evaluation\n`/wavmind release [description]` — Release checklist\n`/wavmind marketplace [details]` — Monetization\n`/wavmind career` — Career path\n`/wavmind sprint [goal]` — Weekly plan\n`/wavmind trending [topic]` — Music news'),
    divider(),
    header('📊 Powered By'),
    twoCol('🤖 *AI*\nGroq — Llama 3.1', '🎵 *Data*\nSpotify API'),
    twoCol('📰 *News*\nNewsData.io', '🎧 *Audio*\nLibrosa'),
    divider(),
    context('🎛️ *Wavmind* — Autonomous AI agent for music producers'),
  );

  await client.views.publish({ user_id: userId, view: { type: 'home', blocks } });
}

app.event('app_home_opened', async ({ event, client }) => {
  try { await publishAppHome(client, event.user); } catch (err) { console.error('Home error:', err.message); }
});

// ─── BUTTON HANDLERS ─────────────────────────────────────
app.action('btn_health', async ({ body, ack, client }) => {
  await ack();
  const blocks = getHealthBlocks(body.user.id);
  blocks.push(divider(), context('💡 Update your project: `/wavmind project set bpm:140 key:F_minor genre:trap`'));
  await client.chat.postMessage({ channel: body.user.id, blocks });
});

app.action('btn_feedback', async ({ body, ack, client }) => {
  await ack();
  await client.chat.postMessage({
    channel: body.user.id,
    blocks: [
      header('🎚️ Ready to Analyze Your Mix'),
      section('Describe your mix and I\'ll give you feedback + an action plan:'),
      section('`/wavmind feedback My trap beat at 140bpm feels muddy in the low end`'),
      divider(),
      section('Or upload an MP3/WAV file directly and I\'ll scan it automatically!'),
    ],
  });
});

app.action('btn_ar', async ({ body, ack, client }) => {
  await ack();
  await client.chat.postMessage({
    channel: body.user.id,
    blocks: [
      header('🎯 A&R Evaluation'),
      section('Describe your track and I\'ll evaluate it like a label executive:'),
      section('`/wavmind ar Dark trap beat at 140bpm, heavy 808s, melodic piano loop`'),
    ],
  });
});

// ─── FILE UPLOAD ─────────────────────────────────────────
app.event('file_shared', async ({ event, client }) => {
  try {
    const fileInfo = await client.files.info({ file: event.file_id });
    const file = fileInfo.file;
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['mp3','wav','flac','aac','m4a','ogg'].includes(ext)) return;

    await client.chat.postMessage({ channel: event.channel_id, blocks: [header('🎵 Scanning Your Track...'), section(`*File:* ${file.name}`), context('⏳ Analyzing energy, brightness and bass...')] });

    const analysis = await analyzeAudioFile(file.url_private_download, file.name);
    if (!analysis || analysis.error) {
      await client.chat.postMessage({ channel: event.channel_id, blocks: [header('❗ Scan Failed'), section(`Could not analyze *${file.name}*. Try smaller file or MP3.`)] });
      return;
    }

    global.pendingAnalysis = global.pendingAnalysis || {};
    global.pendingAnalysis[event.channel_id] = { filename: file.name, energy: analysis.energy, brightness: analysis.brightness, bass_ratio: analysis.bass_ratio, duration: analysis.duration };

    // Update project if exists
    const userId = event.user_id;
    if (userId && memory.getProject(userId)) {
      memory.saveProject(userId, { audioUploaded: true });
    }

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
        section('*🎵 Ready for AI mixing feedback + action plan?*\n\nProvide your BPM and Key:'),
        section('```/wavmind mixfeedback bpm:85 key:F_minor```'),
        context('💡 Key format: `C_major` · `F_minor` · `G_major` · `A_minor` · `Bb_major`'),
      ],
    });
  } catch (err) { console.error('File error:', err.message); }
});

// ─── SLASH COMMANDS ───────────────────────────────────────
app.command('/wavmind', async ({ command, ack, respond, client }) => {
  await ack();
  const input = command.text.trim();
  const lower = input.toLowerCase();
  const userId = command.user_id;

  if (!input || lower === 'help') {
    await respond({
      response_type: 'ephemeral',
      blocks: [
        header('🎛️ Wavmind — Autonomous AI Producer Agent'),
        section('*Your complete music production management system inside Slack.*'),
        divider(),
        section('*🧠 Project Memory*\n`/wavmind project new "Name"` — Create project\n`/wavmind project` — View project\n`/wavmind project set bpm:140 key:F_minor genre:trap`\n`/wavmind project ref [track]` — Add reference\n`/wavmind project task [task]` — Add task\n`/wavmind health` — Project health dashboard'),
        section('*🎵 Production*\n`/wavmind ideas [genre]` — Full production concept\n`/wavmind feedback [mix description]` — Feedback + action plan\n`/wavmind reference [track]` — Track blueprint\n`/wavmind compare [artist] and [artist]` — Artist DNA\n`/wavmind bpm [genre]` — BPM & key suggestions\n`/wavmind chords [key + genre]` — Chord progressions\n`/wavmind tips [topic]` — Production tips'),
        section('*🏆 Agent Features*\n`/wavmind ar [description]` — A&R label evaluation\n`/wavmind release [description]` — Release readiness\n`/wavmind marketplace [details]` — Monetization advisor\n`/wavmind career` — Career path finder\n`/wavmind sprint [goal]` — Production sprint\n`/wavmind deadline [date]` — Set release deadline\n`/wavmind trending [topic]` — Music news'),
        section('*🤝 Collaboration*\n`/wavmind collab start "Track"` · `idea` · `feedback` · `decision` · `summary` · `end`'),
        divider(),
        section('*🎛️ Audio Analysis*\nUpload MP3/WAV → auto scan → `/wavmind mixfeedback bpm:85 key:F_minor`'),
        divider(),
        context('💬 @mention Wavmind anywhere to ask anything about music production'),
      ],
    });
    return;
  }

  // ─── HEALTH ──────────────────────────────────────────
  if (lower === 'health') {
    const blocks = getHealthBlocks(userId);
    blocks.push(divider());
    blocks.push(buttonRow([
      actionButton('🎚️ Analyze Mix', 'btn_feedback', 'feedback', 'primary'),
      actionButton('🎯 A&R Evaluate', 'btn_ar', 'ar'),
    ]));
    blocks.push(context('💡 Complete missing items to increase your health score'));
    await respond({ blocks });
    return;
  }

  // ─── DEADLINE ────────────────────────────────────────
  if (lower.startsWith('deadline')) {
    const dateStr = input.slice(8).trim();
    const project = memory.getProject(userId);
    if (!project) {
      await respond({ blocks: [header('❗ No Active Project'), section('`/wavmind project new "Track Name"`')] });
      return;
    }
    if (!dateStr) {
      await respond({ blocks: [header('❗ Missing Date'), section('*Example:*\n`/wavmind deadline June 15`\n`/wavmind deadline 2026-06-15`')] });
      return;
    }

    const parsed = new Date(dateStr);
    if (isNaN(parsed.getTime())) {
      await respond({ blocks: [header('❗ Invalid Date'), section('*Examples:*\n`/wavmind deadline June 15`\n`/wavmind deadline 2026-06-15`')] });
      return;
    }

    memory.saveProject(userId, { deadline: parsed.toISOString().split('T')[0] });
    const daysLeft = daysUntil(parsed.toISOString());

    await respond({
      blocks: [
        header('📅 Release Deadline Set'),
        section(`*${project.name}*\n*Release Date:* ${parsed.toLocaleDateString()}\n*Days Remaining:* ${daysLeft}`),
        divider(),
        section(daysLeft <= 7 ? `⚠️ *That's soon!* Make sure you've completed:\n• Mix and master\n• Artwork\n• Metadata\n• Distribution setup\n\nRun \`/wavmind health\` to check readiness.` : `✅ You have ${daysLeft} days. Use \`/wavmind sprint [goal]\` to plan your week.`),
        context('💡 Wavmind will show a countdown on your Home tab'),
      ],
    });
    await publishAppHome(client, userId);
    return;
  }

  // ─── PROJECT ─────────────────────────────────────────
  if (lower.startsWith('project')) {
    const sub = input.slice(7).trim();
    const subL = sub.toLowerCase();

    if (subL.startsWith('new')) {
      const name = sub.slice(3).trim().replace(/['"]/g, '') || 'Untitled Track';
      memory.createProject(userId, name);
      await respond({
        response_type: 'in_channel',
        blocks: [
          header('🧠 Project Created'),
          section(`*Track:* "${name}"\n*Producer:* <@${userId}>`),
          section(`*Health Score:* ${progressBar(7)}`),
          divider(),
          section('Set up your project:'),
          section('`/wavmind project set bpm:140 key:F_minor genre:trap`\n`/wavmind project ref Blinding Lights - The Weeknd`\n`/wavmind project task Mix the 808s`\n`/wavmind deadline June 15`'),
          divider(),
          buttonRow([
            actionButton('📊 View Health', 'btn_health', 'health', 'primary'),
            actionButton('🎚️ Analyze Mix', 'btn_feedback', 'feedback'),
          ]),
          context('💡 Your project dashboard is now live on the Home tab'),
        ],
      });
      await publishAppHome(client, userId);
      return;
    }

    if (subL.startsWith('set')) {
      const project = memory.getProject(userId);
      if (!project) { await respond({ blocks: [header('❗ No Project'), section('`/wavmind project new "Name"`')] }); return; }
      const parts = sub.slice(3).trim();
      const updates = {};
      const bpmMatch = parts.match(/bpm[:\s]+(\d+)/i);
      const keyMatch = parts.match(/key[:\s]+([\w#b_]+)/i);
      const genreMatch = parts.match(/genre[:\s]+([^\s]+(?:\s+[^\s]+)*)/i);
      if (bpmMatch) updates.bpm = parseInt(bpmMatch[1]);
      if (keyMatch) updates.key = keyMatch[1].replace(/_/g, ' ');
      if (genreMatch) updates.genre = genreMatch[1];
      memory.saveProject(userId, updates);
      const updated = memory.getProject(userId);
      const health = memory.calculateHealthScore(userId);
      await respond({
        blocks: [
          header('🧠 Project Updated'),
          section(`*${updated.name}*\n*Health:* ${progressBar(health.score)}`),
          twoCol(`🥁 *BPM*\n${updated.bpm || '_Not set_'}`, `🎼 *Key*\n${updated.key || '_Not set_'}`),
          twoCol(`🎸 *Genre*\n${updated.genre || '_Not set_'}`, `🔍 *References*\n${updated.references.length} saved`),
          context('💡 `/wavmind health` for full dashboard'),
        ],
      });
      await publishAppHome(client, userId);
      return;
    }

    if (subL.startsWith('ref')) {
      const project = memory.getProject(userId);
      if (!project) { await respond({ blocks: [header('❗ No Project'), section('`/wavmind project new "Name"`')] }); return; }
      const ref = sub.slice(3).trim();
      if (!ref) { await respond({ blocks: [header('❗ Missing Reference'), section('`/wavmind project ref Blinding Lights - The Weeknd`')] }); return; }
      project.references.push(ref);
      memory.saveProject(userId, { references: project.references });
      await respond({ blocks: [header('🔍 Reference Added'), section(`*"${ref}"* → *${project.name}*`), context(`📚 ${project.references.length} references saved`)] });
      await publishAppHome(client, userId);
      return;
    }

    if (subL.startsWith('task')) {
      const project = memory.getProject(userId);
      if (!project) { await respond({ blocks: [header('❗ No Project'), section('`/wavmind project new "Name"`')] }); return; }
      const task = sub.slice(4).trim();
      if (!task) { await respond({ blocks: [header('❗ Missing Task'), section('`/wavmind project task Mix the 808s`')] }); return; }
      project.tasks.push(task);
      memory.saveProject(userId, { tasks: project.tasks });
      await respond({ blocks: [header('📋 Task Added'), section(`*"${task}"* → *${project.name}*`), context(`📋 ${project.tasks.length} tasks`)] });
      await publishAppHome(client, userId);
      return;
    }

    if (subL.startsWith('clear')) {
      memory.deleteProject(userId);
      await respond({ blocks: [header('🗑️ Project Cleared'), section('`/wavmind project new "Track Name"` to start fresh')] });
      await publishAppHome(client, userId);
      return;
    }

    const project = memory.getProject(userId);
    if (!project) { await respond({ blocks: [header('🧠 No Project'), section('`/wavmind project new "Track Name"`')] }); return; }
    const health = memory.calculateHealthScore(userId);
    await respond({
      blocks: [
        header('🧠 Your Project'),
        section(`*${project.name}*\n*Health:* ${progressBar(health.score)}`),
        divider(),
        twoCol(`🥁 *BPM*\n${project.bpm || '_Not set_'}`, `🎼 *Key*\n${project.key || '_Not set_'}`),
        twoCol(`🎸 *Genre*\n${project.genre || '_Not set_'}`, `📅 *Deadline*\n${project.deadline || '_Not set_'}`),
        project.references.length > 0 ? section(`🔍 *References:* ${project.references.join(', ')}`) : section('🔍 *References:* _None yet_'),
        project.tasks.length > 0 ? section(`📋 *Tasks:*\n${project.tasks.map(t => `• ${t}`).join('\n')}`) : section('📋 *Tasks:* _None yet_'),
        divider(),
        buttonRow([
          actionButton('📊 Full Health Score', 'btn_health', 'health', 'primary'),
          actionButton('🎚️ Analyze Mix', 'btn_feedback', 'feedback'),
          actionButton('🎯 A&R Evaluate', 'btn_ar', 'ar'),
        ]),
      ],
    });
    return;
  }

  // ─── TASK DONE ───────────────────────────────────────
  if (lower.startsWith('task done')) {
    const num = parseInt(input.slice(9).trim()) - 1;
    const plan = memory.getActionPlan(userId);
    if (!plan) { await respond({ blocks: [header('❗ No Action Plan'), section('Get mix feedback first:\n`/wavmind feedback [describe mix]`')] }); return; }
    memory.completeTask(userId, num);
    const updated = memory.getActionPlan(userId);
    const pct = Math.round((updated.completed.length / updated.items.length) * 100);
    await respond({
      blocks: [
        header('✅ Task Completed!'),
        section(`${progressBar(pct)}\n\n${updated.items.map((item, i) => updated.completed.includes(i) ? `✅ ~${item}~` : `☐ ${item}`).join('\n')}`),
        context(`${updated.completed.length}/${updated.items.length} done`),
      ],
    });
    await publishAppHome(client, userId);
    return;
  }

  // ─── A&R ─────────────────────────────────────────────
  if (lower.startsWith('ar ') || lower === 'ar') {
    const desc = input.slice(2).trim();
    if (!desc) { await respond({ blocks: [header('❗ Missing Description'), section('`/wavmind ar Dark trap beat at 140bpm, heavy 808s, melodic piano`')] }); return; }
    await respond({ blocks: [header('🎯 A&R Evaluation...'), section(`_"${desc}"_`), context('⏳ Label executive reviewing...')] });
    const project = memory.getProject(userId);
    const ctx = project ? `Project: "${project.name}", BPM ${project.bpm}, Key ${project.key}, Genre ${project.genre}.` : '';
    const response = await askAI(`You are a senior A&R executive. Evaluate: "${desc}" ${ctx}
Give: Commercial Potential (1-10), Playlist Potential, Target Audience, Strengths, Weaknesses, Market Positioning, Verdict (pass/consider/strong interest). Be honest and specific.`);
    if (project) { memory.saveProject(userId, { arEvaluated: true }); await publishAppHome(client, userId); }
    await respond({ blocks: [header('🎯 A&R Evaluation'), section(`*Track:* _${desc}_`), divider(), section(response || 'Could not generate.'), divider(), buttonRow([actionButton('✅ Release Check', 'btn_release_check', desc), actionButton('💰 Marketplace', 'btn_marketplace', desc)]), context('💡 `/wavmind release [description]` for release readiness')] });
    return;
  }

  // ─── RELEASE ─────────────────────────────────────────
  if (lower.startsWith('release')) {
    const desc = input.slice(7).trim();
    if (!desc) { await respond({ blocks: [header('❗ Missing Description'), section('`/wavmind release Trap beat 140bpm mixed and mastered`')] }); return; }
    await respond({ blocks: [header('✅ Checking Release Readiness...'), context('⏳ Running checklist...')] });
    const response = await askAI(`You are a mastering engineer and release consultant. Check release readiness for: "${desc}"
Evaluate: Mix Quality, Loudness (target LUFS), Metadata needed, Distribution platforms, Release strategy, Cover art requirements, Pre-save campaign, Overall Readiness Score X/10. Format as checklist with ✅ or ⚠️.`);
    await respond({ blocks: [header('✅ Release Readiness'), section(`*Track:* _${desc}_`), divider(), section(response || 'Could not generate.'), divider(), context('💡 `/wavmind ar [description]` for A&R evaluation')] });
    return;
  }

  // ─── MARKETPLACE ─────────────────────────────────────
  if (lower.startsWith('marketplace')) {
    const desc = input.slice(11).trim();
    if (!desc) { await respond({ blocks: [header('❗ Missing Details'), section('`/wavmind marketplace dark trap 140bpm F minor`')] }); return; }
    await respond({ blocks: [header('💰 Building Strategy...'), context('⏳ Analyzing market...')] });
    const response = await askAI(`You are a beat marketplace expert. Create strategy for: "${desc}"
Provide: BeatStars Title (SEO), 20 Tags, Description for buyers, YouTube Title, YouTube Description, Price Points (MP3/WAV/trackout/exclusive), Target Artists, Marketing Strategy. Be specific with current market rates.`);
    await respond({ blocks: [header('💰 Marketplace Strategy'), section(`*Beat:* ${desc}`), divider(), section(response || 'Could not generate.'), divider(), context('💡 `/wavmind ar [description]` to check commercial potential')] });
    return;
  }

  // ─── CAREER ──────────────────────────────────────────
  if (lower.startsWith('career')) {
    const details = input.slice(6).trim();
    await respond({ blocks: [header('🚀 Analyzing Career Path...'), context('⏳ Building roadmap...')] });
    const response = await askAI(`You are a music industry career coach. ${details ? `Producer says: "${details}".` : ''} Analyze top 3 career paths from: Producer, Mixing Engineer, Mastering Engineer, Sound Designer, Film Composer, Sample Pack Creator, Beat Seller. For each: why it fits, skills needed, income potential, first 3 steps this week. End with one bold recommendation.`);
    await respond({ blocks: [header('🚀 Career Roadmap'), divider(), section(response || 'Could not generate.'), divider(), context('💡 `/wavmind sprint [goal]` to start your career plan')] });
    return;
  }

  // ─── SPRINT ──────────────────────────────────────────
  if (lower.startsWith('sprint')) {
    const goal = input.slice(6).trim();
    if (!goal) { await respond({ blocks: [header('❗ Missing Goal'), section('`/wavmind sprint Finish my EP this week`')] }); return; }
    await respond({ blocks: [header('📅 Creating Sprint...'), section(`*Goal:* ${goal}`), context('⏳ Building plan...')] });
    const response = await askAI(`Create a 7-day production sprint for: "${goal}". Day-by-day plan with 2-3 specific tasks each day. End with success metrics. Be realistic and specific.`);
    const tasks = ['Day 1 tasks', 'Day 2 tasks', 'Day 3 tasks', 'Day 4 tasks', 'Day 5 tasks', 'Day 6 tasks', 'Day 7 review'];
    memory.saveSprintPlan(userId, { goal, tasks });
    await respond({
      response_type: 'in_channel',
      blocks: [header('📅 Sprint Created'), section(`*Goal:* ${goal}\n${progressBar(0)}`), divider(), section(response || 'Could not generate.'), divider(), context('💡 Sprint is on your Home tab · `/wavmind health` to see overall progress')],
    });
    await publishAppHome(client, userId);
    return;
  }

  // ─── COLLAB ──────────────────────────────────────────
  if (lower.startsWith('collab')) {
    const sub = input.slice(6).trim();
    const subL = sub.toLowerCase();
    if (subL.startsWith('start')) {
      const name = sub.slice(5).trim().replace(/['"]/g, '') || 'Untitled';
      if (getCollabSession(command.channel_id)) { await respond({ blocks: [header('⚠️ Session Active'), section('`/wavmind collab end` first')] }); return; }
      startCollabSession(command.channel_id, name, userId);
      await respond({ response_type: 'in_channel', blocks: [header('🤝 Collab Started'), section(`*Track:* "${name}"\n*By:* <@${userId}>`), divider(), twoCol('💡 `/wavmind collab idea [idea]`', '🎚️ `/wavmind collab feedback [fb]`'), twoCol('✅ `/wavmind collab decision [dec]`', '📋 `/wavmind collab summary`'), context(`Session active · /wavmind collab end to finish`)] });
      return;
    }
    if (subL.startsWith('idea')) { const t = sub.slice(4).trim(); const s = getCollabSession(command.channel_id); if (!s) { await respond({ blocks: [header('❗ No Session'), section('`/wavmind collab start "Name"`')] }); return; } if (!t) { await respond({ blocks: [header('❗ Missing'), section('`/wavmind collab idea [idea]`')] }); return; } s.ideas.push({ text: t, user: userId }); await respond({ response_type: 'in_channel', blocks: [header('💡 Idea Logged'), section(`*"${t}"*\n— <@${userId}>`), context(`💡 ${s.ideas.length} ideas for "${s.trackName}"`)] }); return; }
    if (subL.startsWith('feedback')) { const t = sub.slice(8).trim(); const s = getCollabSession(command.channel_id); if (!s) { await respond({ blocks: [header('❗ No Session'), section('`/wavmind collab start "Name"`')] }); return; } if (!t) { await respond({ blocks: [header('❗ Missing'), section('`/wavmind collab feedback [fb]`')] }); return; } s.feedback.push({ text: t, user: userId }); await respond({ response_type: 'in_channel', blocks: [header('🎚️ Feedback Logged'), section(`*"${t}"*\n— <@${userId}>`), context(`🎚️ ${s.feedback.length} feedback for "${s.trackName}"`)] }); return; }
    if (subL.startsWith('decision')) { const t = sub.slice(8).trim(); const s = getCollabSession(command.channel_id); if (!s) { await respond({ blocks: [header('❗ No Session'), section('`/wavmind collab start "Name"`')] }); return; } if (!t) { await respond({ blocks: [header('❗ Missing'), section('`/wavmind collab decision [dec]`')] }); return; } s.decisions.push({ text: t, user: userId }); await respond({ response_type: 'in_channel', blocks: [header('✅ Decision Logged'), section(`*"${t}"*\n— <@${userId}>`), context(`✅ ${s.decisions.length} decisions for "${s.trackName}"`)] }); return; }
    if (subL.startsWith('summary')) { const s = getCollabSession(command.channel_id); if (!s) { await respond({ blocks: [header('❗ No Session'), section('`/wavmind collab start "Name"`')] }); return; } await respond({ blocks: [header('📋 Generating...'), context('⏳')] }); const r = await askAI(`Summarize collab for "${s.trackName}": IDEAS: ${s.ideas.map(i=>i.text).join(', ')||'None'} FEEDBACK: ${s.feedback.map(f=>f.text).join(', ')||'None'} DECISIONS: ${s.decisions.map(d=>d.text).join(', ')||'None'}. Give overview, directions, issues, next steps.`); await respond({ response_type: 'in_channel', blocks: [header('📋 Summary'), section(`*"${s.trackName}"*`), divider(), twoCol(`💡 ${s.ideas.length} ideas`, `🎚️ ${s.feedback.length} feedback`), divider(), section(r||'Error'), context('`/wavmind collab end` to finish')] }); return; }
    if (subL.startsWith('end')) { const s = getCollabSession(command.channel_id); if (!s) { await respond({ blocks: [header('❗ No Session')] }); return; } const r = await askAI(`Final report for "${s.trackName}": IDEAS: ${s.ideas.map(i=>i.text).join(', ')||'None'} FEEDBACK: ${s.feedback.map(f=>f.text).join(', ')||'None'} DECISIONS: ${s.decisions.map(d=>d.text).join(', ')||'None'}. Overview, decisions, action items, closing note.`); endCollabSession(command.channel_id); await respond({ response_type: 'in_channel', blocks: [header('🏁 Session Complete'), section(`*"${s.trackName}"*`), divider(), section(r||'Error'), context('`/wavmind collab start "Name"` for new session')] }); return; }
    await respond({ blocks: [header('🤝 Collab Mode'), section('`start` · `idea` · `feedback` · `decision` · `summary` · `end`')] });
    return;
  }

  // ─── TRENDING ────────────────────────────────────────
  if (lower.startsWith('trending')) {
    const topic = input.slice(8).trim() || 'music production';
    await respond({ blocks: [header('📰 Fetching News...'), context('⏳ Scanning...')] });
    const articles = await getTrendingMusic(topic);
    if (!articles) { await respond({ blocks: [header('❗ No Results'), section('Try: `/wavmind trending trap` or `/wavmind trending plugins`')] }); return; }
    const newsText = articles.map((a, i) => `${i + 1}. *${a.title}*\n_${a.source} · ${a.date}_`).join('\n\n');
    const ai = await askAI(`Based on these music news about "${topic}": ${articles.map(a => a.title).join(', ')}. Tell producers: what this means, key trends, how to use them. Be specific.`);
    await respond({ blocks: [header('📰 Music News'), section(`*Topic:* ${topic}`), divider(), section(newsText), divider(), section('🎛️ *Producer Insights:*'), section(ai || 'Error'), divider(), context('`/wavmind trending DAW` · `/wavmind trending plugins`')] });
    return;
  }

  // ─── COMPARE ─────────────────────────────────────────
  if (lower.startsWith('compare')) {
    const artists = input.slice(7).trim();
    if (!artists || artists.split(' ').length < 2) { await respond({ blocks: [header('❗ Need Two Artists'), section('`/wavmind compare Drake and Travis Scott`')] }); return; }
    await respond({ blocks: [header('🔍 Comparing...'), context('⏳ Fetching Spotify data...')] });
    let a1, a2;
    if (artists.toLowerCase().includes(' and ')) { [a1, a2] = artists.split(/\s+and\s+/i).map(s => s.trim()); }
    else if (artists.toLowerCase().includes(' vs ')) { [a1, a2] = artists.split(/\s+vs\s+/i).map(s => s.trim()); }
    else { const w = artists.split(' '); const m = Math.ceil(w.length / 2); a1 = w.slice(0, m).join(' '); a2 = w.slice(m).join(' '); }
    const [s1, s2] = await Promise.all([getArtistStats(a1), getArtistStats(a2)]);
    if (!s1 || !s2) { await respond({ blocks: [header('❗ Not Found'), section('`/wavmind compare Drake and Travis Scott`')] }); return; }
    const ai = await askAI(`Compare ${s1.name} (BPM ${s1.bpm}, Energy ${s1.energy}%, Dance ${s1.danceability}%, Valence ${s1.valence}%, Loud ${s1.loudness}dB) vs ${s2.name} (BPM ${s2.bpm}, Energy ${s2.energy}%, Dance ${s2.danceability}%, Valence ${s2.valence}%, Loud ${s2.loudness}dB). Key differences, unique sounds, how to blend, which genres each suits.`);
    await respond({ blocks: [header('🎤 Artist DNA'), section(`*${s1.name}* vs *${s2.name}*`), divider(),
      { type: 'section', fields: [{ type: 'mrkdwn', text: `*${s1.name}*` }, { type: 'mrkdwn', text: `*${s2.name}*` }] },
      { type: 'section', fields: [{ type: 'mrkdwn', text: `🥁 BPM: *${s1.bpm}*` }, { type: 'mrkdwn', text: `🥁 BPM: *${s2.bpm}*` }] },
      { type: 'section', fields: [{ type: 'mrkdwn', text: `⚡ Energy: *${s1.energy}%*` }, { type: 'mrkdwn', text: `⚡ Energy: *${s2.energy}%*` }] },
      { type: 'section', fields: [{ type: 'mrkdwn', text: `💃 Dance: *${s1.danceability}%*` }, { type: 'mrkdwn', text: `💃 Dance: *${s2.danceability}%*` }] },
      { type: 'section', fields: [{ type: 'mrkdwn', text: `🔊 Loud: *${s1.loudness}dB*` }, { type: 'mrkdwn', text: `🔊 Loud: *${s2.loudness}dB*` }] },
      divider(), section(ai || 'Error'), context('`/wavmind reference [track]` for specific songs')] });
    return;
  }

  // ─── IDEAS ───────────────────────────────────────────
  if (lower.startsWith('ideas')) {
    const genre = input.slice(5).trim() || 'general';
    await respond({ blocks: [header('🎵 Creating Concept...'), context('⏳')] });
    const project = memory.getProject(userId);
    const response = await askAI(`${project ? `Producer's project: "${project.name}", BPM ${project.bpm}, Key ${project.key}.` : ''} Generate 3 complete production concepts for "${genre}". Each with: title, BPM, key, instruments, mood, arrangement, sound design. Be specific.`);
    await respond({ blocks: [header('🎵 Production Concepts'), section(`*Genre:* ${genre}`), divider(), section(response || 'Error'), divider(), context('`/wavmind project set bpm:140 key:F_minor` to save your direction')] });
    return;
  }

  // ─── FEEDBACK ────────────────────────────────────────
  if (lower.startsWith('feedback')) {
    const desc = input.slice(8).trim();
    if (!desc) { await respond({ blocks: [header('❗ Missing'), section('`/wavmind feedback My trap beat at 140bpm feels muddy`')] }); return; }
    await respond({ blocks: [header('🎚️ Analyzing + Action Plan...'), section(`_"${desc}"_`), context('⏳')] });
    const project = memory.getProject(userId);
    const response = await askAI(`${project ? `Project: "${project.name}", BPM ${project.bpm}, Key ${project.key}.` : ''} Give mixing feedback for: "${desc}". Cover EQ, compression, stereo width, arrangement. Then create numbered *Action Plan:* with specific fix tasks.`);
    const parts = response?.split(/action plan:/i);
    const fb = parts?.[0] || response;
    const items = parts?.[1]?.split('\n').filter(l => l.match(/^\d+\.|^•/)).map(l => l.replace(/^\d+\.|^•/, '').trim()).filter(Boolean) || [];
    if (items.length > 0) memory.saveActionPlan(userId, items);
    if (project) { memory.saveProject(userId, { mixAnalyzed: true, feedbackHistory: [...project.feedbackHistory, { desc, time: new Date().toISOString() }] }); }
    const pct = items.length > 0 ? 0 : null;
    await respond({
      blocks: [
        header('🎚️ Mix Feedback'),
        section(`*Your mix:* _${desc}_`),
        divider(),
        section(fb || 'Error'),
        ...(items.length > 0 ? [divider(), header('📋 Action Plan'), section(`${progressBar(0)}\n\n${items.map((item, i) => `${i + 1}. ${item}`).join('\n')}`), context('Mark done: `/wavmind task done [number]`')] : []),
        divider(),
        buttonRow([actionButton('📊 Health Score', 'btn_health', 'health', 'primary')]),
      ],
    });
    await publishAppHome(client, userId);
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
    await respond({ blocks: [header('🎚️ Analyzing...'), twoCol(`🥁 *BPM*\n${bpm}`, `🎵 *Key*\n${key}`), context('⏳')] });
    const ctx = stored ? `Energy: ${stored.energy}%, Brightness: ${stored.brightness}, Bass: ${stored.bass_ratio}%` : '';
    const response = await askAI(`Professional mixing feedback for: BPM ${bpm}, Key ${key}. ${ctx}. Include EQ, compression, arrangement advice. Then numbered *Action Plan:* with specific tasks.`);
    const ap = response?.split(/action plan:/i);
    const fb = ap?.[0] || response;
    const items = ap?.[1]?.split('\n').filter(l => l.match(/^\d+\.|^•/)).map(l => l.replace(/^\d+\.|^•/, '').trim()).filter(Boolean) || [];
    if (items.length > 0) memory.saveActionPlan(userId, items);
    if (global.pendingAnalysis?.[command.channel_id]) delete global.pendingAnalysis[command.channel_id];
    const project = memory.getProject(userId);
    if (project) { memory.saveProject(userId, { mixAnalyzed: true, bpm: project.bpm || bpm, key: project.key || key }); }
    await respond({
      blocks: [
        header('🎛️ Mix Feedback + Action Plan'),
        twoCol(`🥁 *BPM*\n${bpm}`, `🎵 *Key*\n${key}`),
        stored ? twoCol(`⚡ *Energy*\n${stored.energy}%`, `🔊 *Bass*\n${stored.bass_ratio}%`) : divider(),
        divider(),
        section(fb || 'Error'),
        ...(items.length > 0 ? [divider(), section(`*📋 Action Plan:*\n${progressBar(0)}\n\n${items.map((item, i) => `${i + 1}. ${item}`).join('\n')}`), context('`/wavmind task done [number]` to mark complete')] : []),
        divider(),
        buttonRow([actionButton('📊 Health Score', 'btn_health', 'health', 'primary'), actionButton('🎯 A&R Evaluate', 'btn_ar', 'ar')]),
      ],
    });
    await publishAppHome(client, userId);
    return;
  }

  // ─── REFERENCE ───────────────────────────────────────
  if (lower.startsWith('reference')) {
    const q = input.slice(9).trim();
    if (!q) { await respond({ blocks: [header('❗ Missing'), section('`/wavmind reference Blinding Lights - The Weeknd`')] }); return; }
    await respond({ blocks: [header('🔍 Building Blueprint...'), context('⏳ Fetching Spotify data...')] });
    const f = await getTrackFeatures(q);
    if (f) {
      const project = memory.getProject(userId);
      const r = await askAI(`Create production blueprint for ${f.name} by ${f.artist}: BPM ${f.bpm}, Key ${f.key}, Energy ${f.energy}%, Dance ${f.danceability}%, Loud ${f.loudness}dB, Valence ${f.valence}%. ${project ? `Producer's track: "${project.name}" BPM ${project.bpm} Key ${project.key}` : ''} Cover: tempo, key, drums, bass, melody, mix targets, plugins, energy curve.`);
      if (project) { project.references.push(`${f.name} - ${f.artist}`); memory.saveProject(userId, { references: project.references }); await publishAppHome(client, userId); }
      await respond({ blocks: [header('🔍 Reference Blueprint'), section(`*${f.name}* by *${f.artist}*`), divider(), twoCol(`🥁 *BPM*\n${f.bpm}`, `🎵 *Key*\n${f.key}`), twoCol(`⚡ *Energy*\n${f.energy}%`, `💃 *Dance*\n${f.danceability}%`), twoCol(`🔊 *Loudness*\n${f.loudness} dB`, `😊 *Valence*\n${f.valence}%`), divider(), section(r || 'Error'), divider(), context(project ? `✅ Saved to "${project.name}"` : '`/wavmind project new "Name"` to save references')] });
    } else {
      const r = await askAI(`Production blueprint for "${q}". Cover: tempo, key, drums, bass, melody, mix approach.`);
      await respond({ blocks: [header('🔍 Reference Blueprint'), section(`*${q}*`), divider(), section(r || 'Error'), context('Include artist name for better results')] });
    }
    return;
  }

  // ─── BPM ─────────────────────────────────────────────
  if (lower.startsWith('bpm')) {
    const mood = input.slice(3).trim() || 'general';
    await respond({ blocks: [header('🥁 BPM & Key'), section(`*Genre:* ${mood}`), context('⏳')] });
    const r = await askAI(`For "${mood}": ideal BPM range, best keys, chord progressions, song structure. Be specific.`);
    await respond({ blocks: [header('🥁 BPM & Key'), section(`*Genre:* ${mood}`), divider(), section(r || 'Error'), context('`/wavmind chords [key + genre]` for progressions')] });
    return;
  }

  // ─── CHORDS ──────────────────────────────────────────
  if (lower.startsWith('chords')) {
    const q = input.slice(6).trim() || 'C minor trap';
    await respond({ blocks: [header('🎹 Chord Progressions...'), context('⏳')] });
    const r = await askAI(`3 chord progressions for "${q}". Each: chord names, Roman numerals, emotional feel, melody note.`);
    await respond({ blocks: [header('🎹 Chord Progressions'), section(`*${q}*`), divider(), section(r || 'Error'), context('`/wavmind bpm [genre]` for ideal tempo')] });
    return;
  }

  // ─── TIPS ────────────────────────────────────────────
  if (lower.startsWith('tips')) {
    const topic = input.slice(4).trim() || 'music production';
    await respond({ blocks: [header('💡 Tips'), section(`*${topic}*`), context('⏳')] });
    const r = await askAI(`5 professional tips about "${topic}". Real techniques and plugin names. Format with emojis.`);
    await respond({ blocks: [header('💡 Production Tips'), section(`*${topic}*`), divider(), section(r || 'Error'), context('`/wavmind feedback [mix]` for personalized advice')] });
    return;
  }

  // ─── GENERAL ─────────────────────────────────────────
  await respond({ blocks: [header('🤔 Thinking...'), context('⏳')] });
  const response = await askAI(`You are Wavmind, expert AI for music producers. Answer: "${input}"`);
  await respond({ blocks: [header('🎛️ Wavmind'), section(response || 'Error'), divider(), context('`/wavmind` for all commands')] });
});

// ─── BUTTON ACTION STUBS ─────────────────────────────────
app.action('btn_release_check', async ({ ack }) => { await ack(); });
app.action('btn_marketplace', async ({ ack }) => { await ack(); });

// ─── MENTIONS & DMs ───────────────────────────────────────
app.event('app_mention', async ({ event, say }) => {
  const input = event.text.replace(/<@[^>]+>/g, '').trim();
  if (!input) { await say({ blocks: [header('🎛️ Wavmind'), section('Ask me anything about music production!\n\nType `/wavmind` for all commands.')] }); return; }
  const r = await askAI(`You are Wavmind. Answer: "${input}"`);
  await say({ blocks: [section(`<@${event.user}>`), section(r || 'Error'), context('`/wavmind` for all commands')] });
});

app.message(async ({ message, say }) => {
  if (message.subtype || !message.text) return;
  const l = message.text.toLowerCase().trim();
  if (['hi','hello','hey','start','help'].includes(l)) { await say({ blocks: [header('🎛️ Wavmind'), section('Welcome! Type `/wavmind` to see everything I can do.\n\nOr just ask me anything about music production!')] }); return; }
  const r = await askAI(`You are Wavmind. Answer: "${message.text}"`);
  await say({ blocks: [section(r || 'Error'), context('`/wavmind` for all commands')] });
});

// ─── START ────────────────────────────────────────────────
(async () => {
  await app.start();
  console.log('🎛️ Wavmind Agent is running!');
})();
