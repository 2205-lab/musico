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

function button(text, actionId, value) {
  return {
    type: 'actions',
    elements: [{
      type: 'button',
      text: { type: 'plain_text', text, emoji: true },
      action_id: actionId,
      value,
      style: 'primary',
    }],
  };
}

// ─── WELCOME BLOCKS ───────────────────────────────────────
function getWelcomeBlocks() {
  return [
    header('🎛️ Welcome to Musico'),
    section('*Your AI assistant for music production.* Here\'s everything I can do:'),
    divider(),
    section('*🎵 Track Ideas*\n`/musico ideas [genre/mood]`\n_Example: `/musico ideas dark trap beat`_'),
    section('*🎚️ Mixing Feedback*\n`/musico feedback [describe your mix]`\n_Example: `/musico feedback my beat feels muddy at 140bpm`_'),
    section('*🔍 Reference Track Analysis*\n`/musico reference [track - artist]`\n_Pulls real Spotify data and gives you a sound blueprint_\n_Example: `/musico reference Blinding Lights - The Weeknd`_'),
    section('*🥁 BPM & Key Suggestions*\n`/musico bpm [mood or genre]`\n_Example: `/musico bpm dark cinematic hip hop`_'),
    section('*🎹 Chord Progressions*\n`/musico chords [key + genre]`\n_Example: `/musico chords F minor trap`_'),
    section('*💡 Production Tips*\n`/musico tips [topic]`\n_Example: `/musico tips 808 mixing`_'),
    divider(),
    section('*🎛️ Audio File Analysis + Mix Feedback*\n*Step 1:* Upload any MP3 or WAV file directly in Slack\n*Step 2:* I scan your track\'s energy, brightness and bass\n*Step 3:* You tell me your BPM and Key from your DAW\n*Step 4:* I give you professional AI mixing feedback\n\n`/musico mixfeedback bpm:85 key:F_minor`\n_Key format: `C_major` · `F_minor` · `G_major` · `A_minor` · `Bb_major`_'),
    divider(),
    context('💬 Or just @mention me and ask anything about music production!'),
  ];
}

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
        section('*🎵 Ready for AI mixing feedback?*\n\nTell me your BPM and Key from your DAW for accurate professional feedback:'),
        section('```/musico mixfeedback bpm:85 key:F_minor```'),
        section('*Key format examples:*\n`C_major` · `F_minor` · `G_major` · `A_minor` · `Bb_major` · `D_major` · `E_minor`'),
        context('💡 Find your BPM and Key in FL Studio, Ableton, Logic or any DAW'),
      ],
    });

  } catch (err) {
    console.error('File handler error:', err.message);
  }
});

// ─── SLASH COMMANDS ───────────────────────────────────────
app.command('/musico', async ({ command, ack, respond }) => {
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

  // IDEAS
  if (lower.startsWith('ideas')) {
    const genre = input.slice(5).trim() || 'general';
    await respond({
      blocks: [
        header('🎵 Generating Track Ideas...'),
        section(`Genre/mood: *${genre}*`),
      ],
    });
    const response = await askAI(
      `You are Musico, an expert AI music producer assistant. Generate 5 creative and unique track title ideas with brief concept descriptions for: "${genre}". Format each as: 🎵 *Title* — concept description. Be specific and inspiring.`
    );
    await respond({
      blocks: [
        header('🎵 Track Ideas'),
        section(`*Genre/Mood:* ${genre}`),
        divider(),
        section(response || 'Could not generate ideas. Try again!'),
        divider(),
        context('💡 Use `/musico bpm [genre]` to get BPM and key suggestions for your track'),
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
          section('Please describe your mix so I can give feedback.\n\n*Example:*\n`/musico feedback My trap beat at 140bpm feels muddy in the low end`'),
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
      `You are Musico, a professional mixing engineer AI. Give detailed, actionable mixing feedback for: "${description}". Include EQ, compression, stereo width, frequency balance advice. Use music production terminology. Format with clear sections using emojis.`
    );
    await respond({
      blocks: [
        header('🎚️ Mix Feedback'),
        section(`*Your mix:* _${description}_`),
        divider(),
        section(response || 'Could not analyze. Try again!'),
        divider(),
        context('💡 Upload your MP3/WAV for audio scan, then use `/musico mixfeedback bpm:140 key:F_minor` for deeper feedback'),
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
          section('Please provide both BPM and key.\n\n*Format:*\n`/musico mixfeedback bpm:140 key:F_minor`\n\n*Key examples:*\n`C_major` · `F_minor` · `G_major` · `A_minor` · `Bb_major`'),
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
      `You are Musico, a professional mixing engineer. Producer's track details:
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
        context('💡 Use `/musico reference [track name]` to compare your sound with a professional mix'),
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
          section('Please provide a track name.\n\n*Example:*\n`/musico reference Blinding Lights - The Weeknd`'),
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
        `You are Musico, a professional mixing engineer. Give advice on achieving the sound of:
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
          context('💡 Upload your track and use `/musico mixfeedback` to compare your mix'),
        ],
      });
    } else {
      const response = await askAI(
        `You are Musico, a professional mixing engineer. Give detailed advice on achieving the sound of "${trackQuery}". Cover tempo, key, mixing approach, signature sounds, and overall vibe.`
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
      `You are Musico, expert music producer AI. For "${mood}" suggest: ideal BPM range, best musical keys, chord progressions, typical song structure. Be specific with numbers.`
    );
    await respond({
      blocks: [
        header('🥁 BPM & Key Suggestions'),
        section(`*Genre/Mood:* ${mood}`),
        divider(),
        section(response || 'Could not generate. Try again!'),
        divider(),
        context('💡 Use `/musico chords [key + genre]` to get chord progressions'),
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
      `You are Musico, expert music theory AI for producers. Generate 3 chord progressions for: "${query}". For each show: chord names, Roman numeral analysis, emotional feel, suggested melody note. Format clearly.`
    );
    await respond({
      blocks: [
        header('🎹 Chord Progressions'),
        section(`*Query:* ${query}`),
        divider(),
        section(response || 'Could not generate. Try again!'),
        divider(),
        context('💡 Use `/musico bpm [genre]` to find the ideal tempo for these chords'),
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
      `You are Musico, expert music producer AI. Give 5 professional actionable tips about "${topic}". Use real techniques and tool names. Format with emojis and bold titles.`
    );
    await respond({
      blocks: [
        header('💡 Production Tips'),
        section(`*Topic:* ${topic}`),
        divider(),
        section(response || 'Could not generate. Try again!'),
        divider(),
        context('💡 Use `/musico feedback [describe your mix]` to get personalized mixing advice'),
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
    `You are Musico, an expert AI assistant for music producers. Answer professionally: "${input}"`
  );
  await respond({
    blocks: [
      header('🎛️ Musico'),
      section(response || 'Could not respond. Try again!'),
      divider(),
      context('💡 Type `/musico` to see all available commands'),
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
    `You are Musico, an expert AI assistant for music producers. Answer professionally: "${input}"`
  );
  await say({
    blocks: [
      section(`<@${event.user}>`),
      section(response || 'Could not respond. Try again!'),
      divider(),
      context('💡 Type `/musico` to see all available commands'),
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
    `You are Musico, an expert AI for music producers. Answer: "${message.text}"`
  );
  await say({
    blocks: [
      section(response || 'Could not respond. Try again!'),
      divider(),
      context('💡 Type `/musico` to see all available commands'),
    ],
  });
});

// ─── START ────────────────────────────────────────────────
(async () => {
  await app.start();
  console.log('🎛️ Musico is running!');
})();
