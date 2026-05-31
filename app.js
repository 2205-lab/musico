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
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1024,
    });
    return response.choices[0].message.content;
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
function divider() {
  return { type: 'divider' };
}

function header(text) {
  return {
    type: 'header',
    text: { type: 'plain_text', text, emoji: true },
  };
}

function section(text) {
  return {
    type: 'section',
    text: { type: 'mrkdwn', text },
  };
}

function twoCol(left, right) {
  return {
    type: 'section',
    fields: [
      { type: 'mrkdwn', text: left },
      { type: 'mrkdwn', text: right },
    ],
  };
}

function context(text) {
  return {
    type: 'context',
    elements: [{ type: 'mrkdwn', text }],
  };
}

// ─── COLLAB MODE ─────────────────────────────────────────
global.collabSessions = global.collabSessions || {};

function getCollabSession(channelId) {
  return global.collabSessions[channelId] || null;
}

function startCollabSession(channelId, trackName, userId) {
  global.collabSessions[channelId] = {
    trackName,
    startedBy: userId,
    startedAt: new Date().toISOString(),
    ideas: [],
    feedback: [],
    decisions: [],
  };
  return global.collabSessions[channelId];
}

function endCollabSession(channelId) {
  const session = global.collabSessions[channelId];
  delete global.collabSessions[channelId];
  return session;
}

// ─── WELCOME BLOCKS ───────────────────────────────────────
function getWelcomeBlocks() {
  return [
    header('🎛️ Welcome to Wavmind'),
    section('*Your AI assistant for music production.* Here\'s everything I can do:'),
    divider(),
    section('*🎵 Track Ideas*\n`/wavmind ideas [genre/mood]`\n_Example: `/wavmind ideas dark trap beat`_'),
    section('*🎚️ Mixing Feedback*\n`/wavmind feedback [describe your mix]`\n_Example: `/wavmind feedback my beat feels muddy at 140bpm`_'),
    section('*🔍 Reference Track Analysis*\n`/wavmind reference [track - artist]`\n_Pulls real Spotify data and gives you a sound blueprint_\n_Example: `/wavmind reference Blinding Lights - The Weeknd`_'),
    section('*🥁 BPM & Key Suggestions*\n`/wavmind bpm [mood or genre]`\n_Example: `/wavmind bpm dark cinematic hip hop`_'),
    section('*🎹 Chord Progressions*\n`/wavmind chords [key + genre]`\n_Example: `/wavmind chords F minor trap`_'),
    section('*💡 Production Tips*\n`/wavmind tips [topic]`\n_Example: `/wavmind tips 808 mixing`_'),
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
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*🎛️ Wavmind*\n_AI Assistant for Music Producers_',
            },
          },
          { type: 'divider' },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: '🎵 *What can Wavmind do for you?*' },
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: '🎵 *Track Ideas*\nGenerate creative track concepts for any genre or mood' },
              { type: 'mrkdwn', text: '🎚️ *Mix Feedback*\nGet professional mixing advice for your beats' },
            ],
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: '🔍 *Reference Tracks*\nPull real Spotify data from any song and get a sound blueprint' },
              { type: 'mrkdwn', text: '🎹 *Chord Progressions*\nMusic theory-based chord ideas for any key and genre' },
            ],
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: '🥁 *BPM & Key*\nIdeal tempo and key suggestions for any mood' },
              { type: 'mrkdwn', text: '💡 *Production Tips*\nExpert tips on any music production topic' },
            ],
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: '🎛️ *Audio Analysis*\nUpload MP3/WAV — Wavmind scans energy, brightness and bass' },
              { type: 'mrkdwn', text: '🤝 *Collab Mode*\nTrack ideas, feedback and decisions with your team' },
            ],
          },
          { type: 'divider' },
          {
            type: 'header',
            text: { type: 'plain_text', text: '🚀 Quick Start', emoji: true },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Try these commands in any channel:*\n\n`/wavmind ideas dark trap beat`\n`/wavmind reference Blinding Lights - The Weeknd`\n`/wavmind bpm dark cinematic hip hop`\n`/wavmind chords F minor trap`\n`/wavmind tips 808 mixing`\n`/wavmind feedback my beat feels muddy at 140bpm`',
            },
          },
          { type: 'divider' },
          {
            type: 'header',
            text: { type: 'plain_text', text: '🤝 Collab Mode', emoji: true },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'Work on tracks with your team inside Slack:\n\n`/wavmind collab start "Track Name"` — Start a session\n`/wavmind collab idea [idea]` — Log a production idea\n`/wavmind collab feedback [feedback]` — Log mix feedback\n`/wavmind collab decision [decision]` — Log a final decision\n`/wavmind collab summary` — Get full AI session summary\n`/wavmind collab end` — End and archive the session',
            },
          },
          { type: 'divider' },
          {
            type: 'header',
            text: { type: 'plain_text', text: '🎛️ Audio Analysis Workflow', emoji: true },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Step 1* — Upload any MP3 or WAV file in any channel\n*Step 2* — Wavmind scans energy, brightness, bass and duration\n*Step 3* — You provide your BPM and Key from your DAW\n*Step 4* — Wavmind gives you professional AI mixing feedback\n\n`/wavmind mixfeedback bpm:85 key:F_minor`',
            },
          },
          {
            type: 'context',
            elements: [
              { type: 'mrkdwn', text: '💡 Key format: `C_major` · `F_minor` · `G_major` · `A_minor` · `Bb_major` · `D_major` · `E_minor`' },
            ],
          },
          { type: 'divider' },
          {
            type: 'header',
            text: { type: 'plain_text', text: '📊 About Wavmind', emoji: true },
          },
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
              { type: 'mrkdwn', text: '🎧 *Audio Analysis*\nLibrosa Python' },
              { type: 'mrkdwn', text: '⚡ *Response Time*\nUnder 3 seconds' },
            ],
          },
          { type: 'divider' },
          {
            type: 'context',
            elements: [
              { type: 'mrkdwn', text: '🎛️ *Wavmind* — Built for music producers | Type `/wavmind` in any channel to get started' },
            ],
          },
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
        twoCol(
          `⚡ *Energy*\n${analysis.energy}%`,
          `🌈 *Brightness*\n${analysis.brightness}`
        ),
        twoCol(
          `🔊 *Bass Presence*\n${analysis.bass_ratio}%`,
          `⏱️ *Duration*\n${mins}:${secs}`
        ),
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

  // HELP / EMPTY
  if (!input || lower === 'help') {
    await respond({
      response_type: 'ephemeral',
      blocks: getWelcomeBlocks(),
    });
    return;
  }

  // COLLAB
  if (lower.startsWith('collab')) {
    const subInput = input.slice(6).trim();
    const subLower = subInput.toLowerCase();

    // START
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
          twoCol(
            '💡 *Log an idea*\n`/wavmind collab idea [idea]`',
            '🎚️ *Log feedback*\n`/wavmind collab feedback [feedback]`'
          ),
          twoCol(
            '✅ *Log a decision*\n`/wavmind collab decision [decision]`',
            '📋 *Get summary*\n`/wavmind collab summary`'
          ),
          divider(),
          context(`🤝 Session active for "${trackName}" · Use /wavmind collab end to finish`),
        ],
      });
      return;
    }

    // IDEA
    if (subLower.startsWith('idea')) {
      const idea = subInput.slice(4).trim();
      const session = getCollabSession(command.channel_id);

      if (!session) {
        await respond({
          blocks: [
            header('❗ No Active Session'),
            section('Start a collab session first:\n`/wavmind collab start "Track Name"`'),
          ],
        });
        return;
      }

      if (!idea) {
        await respond({
          blocks: [
            header('❗ Missing Idea'),
            section('*Example:*\n`/wavmind collab idea use sidechain compression on the 808`'),
          ],
        });
        return;
      }

      session.ideas.push({
        text: idea,
        user: command.user_id,
        time: new Date().toISOString(),
      });

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

    // FEEDBACK
    if (subLower.startsWith('feedback')) {
      const feedbackText = subInput.slice(8).trim();
      const session = getCollabSession(command.channel_id);

      if (!session) {
        await respond({
          blocks: [
            header('❗ No Active Session'),
            section('Start a collab session first:\n`/wavmind collab start "Track Name"`'),
          ],
        });
        return;
      }

      if (!feedbackText) {
        await respond({
          blocks: [
            header('❗ Missing Feedback'),
            section('*Example:*\n`/wavmind collab feedback the drop feels weak`'),
          ],
        });
        return;
      }

      session.feedback.push({
        text: feedbackText,
        user: command.user_id,
        time: new Date().toISOString(),
      });

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

    // DECISION
    if (subLower.startsWith('decision')) {
      const decision = subInput.slice(8).trim();
      const session = getCollabSession(command.channel_id);

      if (!session) {
        await respond({
          blocks: [
            header('❗ No Active Session'),
            section('Start a collab session first:\n`/wavmind collab start "Track Name"`'),
          ],
        });
        return;
      }

      if (!decision) {
        await respond({
          blocks: [
            header('❗ Missing Decision'),
            section('*Example:*\n`/wavmind collab decision going with F minor key`'),
          ],
        });
        return;
      }

      session.decisions.push({
        text: decision,
        user: command.user_id,
        time: new Date().toISOString(),
      });

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

    // STATUS
    if (subLower.startsWith('status')) {
      const session = getCollabSession(command.channel_id);

      if (!session) {
        await respond({
          blocks: [
            header('❗ No Active Session'),
            section('Start a collab session first:\n`/wavmind collab start "Track Name"`'),
          ],
        });
        return;
      }

      await respond({
        blocks: [
          header('📊 Session Status'),
          section(`*Track:* "${session.trackName}"\n*Started by:* <@${session.startedBy}>`),
          divider(),
          twoCol(
            `💡 *Ideas*\n${session.ideas.length} logged`,
            `🎚️ *Feedback*\n${session.feedback.length} logged`
          ),
          twoCol(
            `✅ *Decisions*\n${session.decisions.length} logged`,
            `⏱️ *Started*\n${new Date(session.startedAt).toLocaleTimeString()}`
          ),
          divider(),
          context('Use `/wavmind collab summary` for full AI summary · `/wavmind collab end` to finish'),
        ],
      });
      return;
    }

    // SUMMARY
    if (subLower.startsWith('summary')) {
      const session = getCollabSession(command.channel_id);

      if (!session) {
        await respond({
          blocks: [
            header('❗ No Active Session'),
            section('Start a collab session first:\n`/wavmind collab start "Track Name"`'),
          ],
        });
        return;
      }

      await respond({
        blocks: [
          header('📋 Generating Session Summary...'),
          section(`Analyzing everything logged for *"${session.trackName}"*`),
          context('⏳ AI is reviewing your session...'),
        ],
      });

      const ideasText = session.ideas.length > 0
        ? session.ideas.map((i, n) => `${n + 1}. ${i.text}`).join('\n')
        : 'None logged';

      const feedbackText = session.feedback.length > 0
        ? session.feedback.map((f, n) => `${n + 1}. ${f.text}`).join('\n')
        : 'None logged';

      const decisionsText = session.decisions.length > 0
        ? session.decisions.map((d, n) => `${n + 1}. ${d.text}`).join('\n')
        : 'None logged';

      const summary = await askAI(
        `You are Wavmind, an AI assistant for music producers. Summarize this collab session for the track "${session.trackName}":

IDEAS LOGGED:
${ideasText}

FEEDBACK LOGGED:
${feedbackText}

DECISIONS MADE:
${decisionsText}

Give a professional summary including:
- Overview of the session
- Key creative directions identified
- Main issues to address
- Final decisions made
- Recommended next steps for completing this track

Format with clear sections and emojis. Be specific and actionable.`
      );

      await respond({
        response_type: 'in_channel',
        blocks: [
          header('📋 Session Summary'),
          section(`*Track:* "${session.trackName}"`),
          divider(),
          twoCol(
            `💡 *Ideas logged*\n${session.ideas.length}`,
            `🎚️ *Feedback logged*\n${session.feedback.length}`
          ),
          twoCol(
            `✅ *Decisions made*\n${session.decisions.length}`,
            `⏱️ *Session duration*\nSince ${new Date(session.startedAt).toLocaleTimeString()}`
          ),
          divider(),
          section(summary || 'Could not generate summary. Try again!'),
          divider(),
          context('Use `/wavmind collab end` to end the session · `/wavmind collab status` to check progress'),
        ],
      });
      return;
    }

    // END
    if (subLower.startsWith('end')) {
      const session = getCollabSession(command.channel_id);

      if (!session) {
        await respond({
          blocks: [
            header('❗ No Active Session'),
            section('There is no active collab session in this channel.'),
          ],
        });
        return;
      }

      await respond({
        blocks: [
          header('📋 Generating Final Summary...'),
          section(`Wrapping up session for *"${session.trackName}"*`),
          context('⏳ Creating final report...'),
        ],
      });

      const ideasText = session.ideas.length > 0
        ? session.ideas.map((i, n) => `${n + 1}. ${i.text}`).join('\n')
        : 'None logged';

      const feedbackText = session.feedback.length > 0
        ? session.feedback.map((f, n) => `${n + 1}. ${f.text}`).join('\n')
        : 'None logged';

      const decisionsText = session.decisions.length > 0
        ? session.decisions.map((d, n) => `${n + 1}. ${d.text}`).join('\n')
        : 'None logged';

      const finalSummary = await askAI(
        `You are Wavmind, an AI assistant for music producers. Create a final session report for the track "${session.trackName}":

IDEAS:
${ideasText}

FEEDBACK:
${feedbackText}

DECISIONS:
${decisionsText}

Write a final production report with:
- Session overview
- Creative direction established
- Technical decisions made
- Problems identified and solutions
- Clear action items for next session
- Encouraging closing note for the team

Format professionally with emojis and clear sections.`
      );

      endCollabSession(command.channel_id);

      await respond({
        response_type: 'in_channel',
        blocks: [
          header('🏁 Collab Session Complete'),
          section(`*Track:* "${session.trackName}"\n*Started by:* <@${session.startedBy}>`),
          divider(),
          twoCol(
            `💡 *Total ideas*\n${session.ideas.length}`,
            `🎚️ *Total feedback*\n${session.feedback.length}`
          ),
          twoCol(
            `✅ *Total decisions*\n${session.decisions.length}`,
            `⏱️ *Session started*\n${new Date(session.startedAt).toLocaleTimeString()}`
          ),
          divider(),
          section('📋 *Final Session Report:*'),
          section(finalSummary || 'Could not generate report. Try again!'),
          divider(),
          context('🎛️ Start a new session anytime with `/wavmind collab start "Track Name"`'),
        ],
      });
      return;
    }

    // COLLAB HELP
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

  // IDEAS
  if (lower.startsWith('ideas')) {
    const genre = input.slice(5).trim() || 'general';
    await respond({
      blocks: [
        header('🎵 Generating Track Ideas...'),
        section(`Genre/mood: *${genre}*`),
        context('⏳ Thinking creatively...'),
      ],
    });
    const response = await askAI(
      `You are Wavmind, an expert AI music producer assistant. Generate 5 creative and unique track title ideas with brief concept descriptions for: "${genre}". Format each as: 🎵 *Title* — concept description. Be specific and inspiring.`
    );
    await respond({
      blocks: [
        header('🎵 Track Ideas'),
        section(`*Genre/Mood:* ${genre}`),
        divider(),
        section(response || 'Could not generate ideas. Try again!'),
        divider(),
        context('💡 Use `/wavmind bpm [genre]` to get BPM and key suggestions for your track'),
      ],
    });
    return;
  }

  // FEEDBACK
  if (lower.startsWith('feedback')) {
    const description = input.slice(8).trim();
    if (!description) {
      await respond({
        blocks: [
          header('❗ Missing Description'),
          section('Please describe your mix.\n\n*Example:*\n`/wavmind feedback My trap beat at 140bpm feels muddy in the low end`'),
        ],
      });
      return;
    }
    await respond({
      blocks: [
        header('🎚️ Analyzing Your Mix...'),
        section(`_"${description}"_`),
        context('⏳ Generating professional feedback...'),
      ],
    });
    const response = await askAI(
      `You are Wavmind, a professional mixing engineer AI. Give detailed actionable mixing feedback for: "${description}". Include EQ, compression, stereo width, frequency balance advice. Format with clear sections using emojis.`
    );
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

  // MIXFEEDBACK
  if (lower.startsWith('mixfeedback')) {
    const parts = input.slice(11).trim();
    const bpmMatch = parts.match(/bpm[:\s]+(\d+)/i);
    const keyMatch = parts.match(/key[:\s]+([\w#b_]+)/i);

    if (!bpmMatch || !keyMatch) {
      await respond({
        blocks: [
          header('❗ Missing BPM or Key'),
          section('Please provide both BPM and key.\n\n*Format:*\n`/wavmind mixfeedback bpm:140 key:F_minor`\n\n*Key examples:*\n`C_major` · `F_minor` · `G_major` · `A_minor` · `Bb_major`'),
          context('💡 Find your BPM and Key in your DAW'),
        ],
      });
      return;
    }

    const bpm = parseInt(bpmMatch[1]);
    const key = keyMatch[1].replace(/_/g, ' ');
    const stored = global.pendingAnalysis?.[command.channel_id];

    await respond({
      blocks: [
        header('🎚️ Generating Mix Feedback...'),
        twoCol(`🥁 *BPM*\n${bpm}`, `🎵 *Key*\n${key}`),
        context('⏳ Analyzing your track...'),
      ],
    });

    const contextInfo = stored
      ? `Energy: ${stored.energy}%, Brightness: ${stored.brightness}, Bass presence: ${stored.bass_ratio}%`
      : '';

    const response = await askAI(
      `You are Wavmind, a professional mixing engineer. Producer track details:
BPM: ${bpm}
Key: ${key}
${contextInfo}

Give specific professional mixing feedback including:
- What BPM and key suggest about genre and mood
- EQ advice based on brightness and bass ratio if available
- Compression and dynamics recommendations
- Arrangement and energy flow suggestions
- 3 specific improvements for a more professional sound

Use real plugin names and techniques. Format with emojis and clear sections.`
    );

    if (global.pendingAnalysis?.[command.channel_id]) {
      delete global.pendingAnalysis[command.channel_id];
    }

    await respond({
      blocks: [
        header('🎛️ Mix Feedback'),
        twoCol(`🥁 *BPM*\n${bpm}`, `🎵 *Key*\n${key}`),
        stored ? twoCol(
          `⚡ *Energy*\n${stored.energy}%`,
          `🔊 *Bass*\n${stored.bass_ratio}%`
        ) : divider(),
        divider(),
        section(response || 'Could not generate feedback. Try again!'),
        divider(),
        context('💡 Use `/wavmind reference [track name]` to compare your sound with a professional mix'),
      ],
    });
    return;
  }

  // REFERENCE
  if (lower.startsWith('reference')) {
    const trackQuery = input.slice(9).trim();
    if (!trackQuery) {
      await respond({
        blocks: [
          header('❗ Missing Track Name'),
          section('*Example:*\n`/wavmind reference Blinding Lights - The Weeknd`'),
        ],
      });
      return;
    }

    await respond({
      blocks: [
        header('🔍 Looking Up on Spotify...'),
        section(`Searching for *${trackQuery}*`),
        context('⏳ Fetching real audio data...'),
      ],
    });

    const features = await getTrackFeatures(trackQuery);

    if (features) {
      const response = await askAI(
        `You are Wavmind, a professional mixing engineer. Give advice on achieving the sound of:
Track: ${features.name} by ${features.artist}
BPM: ${features.bpm}, Key: ${features.key}
Energy: ${features.energy}%, Danceability: ${features.danceability}%
Loudness: ${features.loudness} dB, Valence: ${features.valence}%
Cover: tempo, key, energy, mixing targets, overall vibe. Be specific.`
      );
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
      const response = await askAI(
        `You are Wavmind, a professional mixing engineer. Give detailed advice on achieving the sound of "${trackQuery}".`
      );
      await respond({
        blocks: [
          header('🎛️ Reference Analysis'),
          section(`*Track:* ${trackQuery}`),
          divider(),
          section(response || 'Could not analyze. Try again!'),
          context('💡 Try including the artist name for better results'),
        ],
      });
    }
    return;
  }

  // BPM
  if (lower.startsWith('bpm')) {
    const mood = input.slice(3).trim() || 'general';
    await respond({
      blocks: [
        header('🥁 BPM & Key Suggestions'),
        section(`*Genre/Mood:* ${mood}`),
        context('⏳ Calculating...'),
      ],
    });
    const response = await askAI(
      `You are Wavmind, expert music producer AI. For "${mood}" suggest: ideal BPM range, best musical keys, chord progressions, typical song structure. Be specific with numbers.`
    );
    await respond({
      blocks: [
        header('🥁 BPM & Key Suggestions'),
        section(`*Genre/Mood:* ${mood}`),
        divider(),
        section(response || 'Could not generate. Try again!'),
        divider(),
        context('💡 Use `/wavmind chords [key + genre]` to get chord progressions'),
      ],
    });
    return;
  }

  // CHORDS
  if (lower.startsWith('chords')) {
    const query = input.slice(6).trim() || 'C minor trap';
    await respond({
      blocks: [
        header('🎹 Generating Chord Progressions...'),
        section(`*Query:* ${query}`),
        context('⏳ Applying music theory...'),
      ],
    });
    const response = await askAI(
      `You are Wavmind, expert music theory AI for producers. Generate 3 chord progressions for: "${query}". For each show: chord names, Roman numeral analysis, emotional feel, suggested melody note. Format clearly.`
    );
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

  // TIPS
  if (lower.startsWith('tips')) {
    const topic = input.slice(4).trim() || 'music production';
    await respond({
      blocks: [
        header('💡 Production Tips'),
        section(`*Topic:* ${topic}`),
        context('⏳ Loading expert knowledge...'),
      ],
    });
    const response = await askAI(
      `You are Wavmind, expert music producer AI. Give 5 professional actionable tips about "${topic}". Use real techniques and tool names. Format with emojis and bold titles.`
    );
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

  // GENERAL
  await respond({
    blocks: [
      header('🤔 Thinking...'),
      context('⏳ Processing your question...'),
    ],
  });
  const response = await askAI(
    `You are Wavmind, an expert AI assistant for music producers. Answer professionally: "${input}"`
  );
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
  if (!input) {
    await say({ blocks: getWelcomeBlocks() });
    return;
  }
  const response = await askAI(
    `You are Wavmind, an expert AI assistant for music producers. Answer professionally: "${input}"`
  );
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
  if (message.subtype) return;
  if (!message.text) return;
  const lower = message.text.toLowerCase().trim();
  if (['hi','hello','hey','start','help'].includes(lower)) {
    await say({ blocks: getWelcomeBlocks() });
    return;
  }
  const response = await askAI(
    `You are Wavmind, an expert AI for music producers. Answer: "${message.text}"`
  );
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
