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
    console.log('Downloading file:', fileUrl);
    const response = await axios.get(fileUrl, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      responseType: 'arraybuffer',
      timeout: 30000,
    });

    fs.writeFileSync(filePath, response.data);
    console.log('File saved:', filePath, fs.statSync(filePath).size, 'bytes');

    const result = execSync(
      `python3 analyze.py "${filePath}"`,
      { timeout: 60000 }
    ).toString().trim();

    console.log('Python result:', result);
    const analysis = JSON.parse(result);

    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return analysis;

  } catch (err) {
    console.error('Audio analysis error:', err.message);
    if (err.stdout) console.error('stdout:', err.stdout.toString());
    if (err.stderr) console.error('stderr:', err.stderr.toString());
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { error: err.message };
  }
}

// ─── WELCOME MESSAGE ─────────────────────────────────────
function getWelcomeMessage() {
  return `🎛️ *Welcome to Musico — AI Assistant for Music Producers!*

Here's everything I can do:

*🎵 Track Ideas*
\`/musico ideas [genre/mood]\`
_Example: \`/musico ideas dark trap beat\`_

*🎚️ Mixing Feedback*
\`/musico feedback [describe your mix]\`
_Example: \`/musico feedback my beat feels muddy at 140bpm\`_

*🔍 Reference Track Analysis*
\`/musico reference [track - artist]\`
_Pulls real Spotify audio data and gives you a blueprint_
_Example: \`/musico reference Blinding Lights - The Weeknd\`_

*🥁 BPM & Key Suggestions*
\`/musico bpm [mood or genre]\`
_Example: \`/musico bpm dark cinematic hip hop\`_

*🎹 Chord Progressions*
\`/musico chords [key + genre]\`
_Example: \`/musico chords F minor trap\`_

*💡 Production Tips*
\`/musico tips [topic]\`
_Example: \`/musico tips 808 mixing\`_

*🎛️ Mix Feedback with Your BPM & Key*
\`/musico mixfeedback bpm:[number] key:[key_mode]\`
_Use this after uploading a track for accurate feedback_
_Example: \`/musico mixfeedback bpm:85 key:F_minor\`_
_Key format: \`C_major\` \`F_minor\` \`G_major\` \`A_minor\` \`Bb_major\`_

*🎵 Audio File Analysis*
_Upload any MP3 or WAV directly in Slack!_
_I will scan the energy, brightness, bass presence and duration_
_Then use \`/musico mixfeedback bpm:85 key:F_minor\` for full AI feedback_

Or just \`@Musico\` and ask me anything about music production! 🎧`;
}

// ─── FILE UPLOAD HANDLER ─────────────────────────────────
app.event('file_shared', async ({ event, client }) => {
  try {
    console.log('File shared:', event);

    const fileInfo = await client.files.info({ file: event.file_id });
    const file = fileInfo.file;

    console.log('File:', file.name, file.mimetype, file.size);

    const audioTypes = ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg'];
    const ext = file.name.split('.').pop().toLowerCase();
    if (!audioTypes.includes(ext)) return;

    await client.chat.postMessage({
      channel: event.channel_id,
      text: `🎵 *Scanning "${file.name}"...*\nAnalyzing energy, brightness, bass and duration. Takes about 15 seconds...`,
    });

    const analysis = await analyzeAudioFile(
      file.url_private_download,
      file.name
    );

    if (!analysis || analysis.error) {
      await client.chat.postMessage({
        channel: event.channel_id,
        text: `❗ Could not scan "${file.name}".\nError: ${analysis?.error || 'Unknown error'}\n\nTry uploading a smaller file (under 10MB) or use MP3 format.`,
      });
      return;
    }

    // Store analysis for this channel
    global.pendingAnalysis = global.pendingAnalysis || {};
    global.pendingAnalysis[event.channel_id] = {
      filename: file.name,
      energy: analysis.energy,
      brightness: analysis.brightness,
      bass_ratio: analysis.bass_ratio,
      danceability: analysis.danceability,
      duration: analysis.duration,
    };

    const mins = Math.floor(analysis.duration / 60);
    const secs = String(analysis.duration % 60).padStart(2, '0');

    await client.chat.postMessage({
      channel: event.channel_id,
      text: `🎛️ *Scan Complete: ${file.name}*

📊 *What I detected:*
- ⚡ Energy: *${analysis.energy}%*
- 🌈 Brightness: *${analysis.brightness}*
- 🔊 Bass presence: *${analysis.bass_ratio}%*
- ⏱️ Duration: *${mins}:${secs}*

━━━━━━━━━━━━━━━━━━━━━━
🎵 *Ready for AI mixing feedback?*

Since you know your track best, tell me your BPM and Key for accurate professional feedback:

\`/musico mixfeedback bpm:85 key:F_minor\`

*Key format examples:*
C_major · F_minor · G_major · A_minor · Bb_major · D_major · E_minor

💡 _You can find your BPM and Key in your DAW (FL Studio, Ableton, Logic etc.)_
━━━━━━━━━━━━━━━━━━━━━━`,
    });

  } catch (err) {
    console.error('File handler error:', err.message);
    console.error(err.stack);
  }
});

// ─── SLASH COMMANDS ───────────────────────────────────────
app.command('/musico', async ({ command, ack, respond }) => {
  await ack();
  const input = command.text.trim();
  const lower = input.toLowerCase();

  // HELP / EMPTY
  if (!input || lower === 'help') {
    await respond({ text: getWelcomeMessage() });
    return;
  }

  // IDEAS
  if (lower.startsWith('ideas')) {
    const genre = input.slice(5).trim() || 'general';
    await respond({ text: '🎵 Generating track ideas...' });
    const response = await askAI(
      `You are Musico, an expert AI music producer assistant. Generate 5 creative and unique track title ideas with brief concept descriptions for this genre/mood: "${genre}". Format each as: 🎵 *Title* — concept description. Be specific and inspiring.`
    );
    await respond({ text: response || 'Could not generate ideas. Try again!' });
    return;
  }

  // FEEDBACK
  if (lower.startsWith('feedback')) {
    const description = input.slice(8).trim();
    if (!description) {
      await respond({
        text: '❗ Please describe your mix.\n\n_Example: `/musico feedback My trap beat at 140bpm feels muddy in the low end`_',
      });
      return;
    }
    await respond({ text: '🎚️ Analyzing your mix...' });
    const response = await askAI(
      `You are Musico, a professional mixing engineer AI. Give detailed, actionable mixing feedback for this track description: "${description}". Include specific advice on: EQ frequencies, compression settings, stereo width, frequency balance, and arrangement. Use music production terminology. Format with clear sections using emojis.`
    );
    await respond({ text: response || 'Could not analyze. Try again!' });
    return;
  }

  // MIXFEEDBACK with manual BPM and key
  if (lower.startsWith('mixfeedback')) {
    const parts = input.slice(11).trim();
    const bpmMatch = parts.match(/bpm[:\s]+(\d+)/i);
    const keyMatch = parts.match(/key[:\s]+([\w#b_]+)/i);

    if (!bpmMatch || !keyMatch) {
      await respond({
        text: `❗ Please provide both BPM and key.\n\n*Format:* \`/musico mixfeedback bpm:140 key:F_minor\`\n\n*Key examples:*\nC_major · F_minor · G_major · A_minor · Bb_major · D_major · E_minor\n\n💡 _Find your BPM and Key in your DAW_`,
      });
      return;
    }

    const bpm = parseInt(bpmMatch[1]);
    const key = keyMatch[1].replace(/_/g, ' ');
    const stored = global.pendingAnalysis?.[command.channel_id];

    await respond({ text: '🎚️ Generating your mix feedback...' });

    const contextInfo = stored
      ? `Energy: ${stored.energy}%, Brightness: ${stored.brightness}, Bass presence: ${stored.bass_ratio}%`
      : '';

    const response = await askAI(
      `You are Musico, a professional mixing engineer. A producer shared these details about their track:

BPM: ${bpm}
Key: ${key}
${contextInfo}

Give them specific, professional mixing feedback. Include:
- What this BPM and key combination suggests about genre and mood
- Specific EQ advice based on the brightness and bass ratio if available
- Compression and dynamics recommendations  
- Arrangement and energy flow suggestions
- 3 specific things to improve for a more professional sound

Use real plugin names and techniques. Format with emojis and clear sections.`
    );

    if (global.pendingAnalysis?.[command.channel_id]) {
      delete global.pendingAnalysis[command.channel_id];
    }

    await respond({
      text: `🎛️ *Mix Feedback — ${bpm} BPM · ${key}*\n\n${response || 'Could not generate feedback. Try again!'}`,
    });
    return;
  }

  // REFERENCE
  if (lower.startsWith('reference')) {
    const trackQuery = input.slice(9).trim();
    if (!trackQuery) {
      await respond({
        text: '❗ Please provide a track name.\n\n_Example: `/musico reference Blinding Lights - The Weeknd`_',
      });
      return;
    }
    await respond({ text: `🔍 Looking up "${trackQuery}" on Spotify...` });
    const features = await getTrackFeatures(trackQuery);

    if (features) {
      const response = await askAI(
        `You are Musico, a professional mixing engineer. Give detailed advice on achieving the sound of this track based on its real Spotify audio data:

Track: ${features.name} by ${features.artist}
BPM: ${features.bpm}
Key: ${features.key}
Energy: ${features.energy}%
Danceability: ${features.danceability}%
Loudness: ${features.loudness} dB
Valence: ${features.valence}%

Cover: tempo and groove, key and harmonic choices, energy and arrangement, mixing targets, overall vibe. Be specific and professional.`
      );
      await respond({
        text: `🎵 *${features.name} by ${features.artist}*

📊 *Real Spotify Data:*
- 🥁 BPM: *${features.bpm}*
- 🎵 Key: *${features.key}*
- ⚡ Energy: *${features.energy}%*
- 💃 Danceability: *${features.danceability}%*
- 🔊 Loudness: *${features.loudness} dB*
- 😊 Valence: *${features.valence}%*

🎛️ *How to achieve this sound:*

${response || 'Could not generate advice. Try again!'}`,
      });
    } else {
      const response = await askAI(
        `You are Musico, a professional mixing engineer. Give detailed advice on achieving the sound of "${trackQuery}". Cover tempo, key, mixing approach, signature sounds, and overall vibe.`
      );
      await respond({
        text: `🎛️ *Reference: ${trackQuery}*\n\n${response || 'Could not analyze. Try again!'}`,
      });
    }
    return;
  }

  // BPM
  if (lower.startsWith('bpm')) {
    const mood = input.slice(3).trim() || 'general';
    await respond({ text: '🥁 Calculating suggestions...' });
    const response = await askAI(
      `You are Musico, an expert music producer AI. For the mood/genre "${mood}", suggest: the ideal BPM range, the best musical keys, chord progressions that work well, and the typical song structure. Format with clear sections and be specific with numbers.`
    );
    await respond({ text: response || 'Could not generate. Try again!' });
    return;
  }

  // CHORDS
  if (lower.startsWith('chords')) {
    const query = input.slice(6).trim() || 'C minor trap';
    await respond({ text: '🎹 Generating chord progressions...' });
    const response = await askAI(
      `You are Musico, an expert music theory AI for producers. Generate 3 different chord progressions for: "${query}". For each show: the chord names, Roman numeral analysis, emotional feel, and a suggested melody note over each chord. Format clearly with sections.`
    );
    await respond({ text: response || 'Could not generate chords. Try again!' });
    return;
  }

  // TIPS
  if (lower.startsWith('tips')) {
    const topic = input.slice(4).trim() || 'music production';
    await respond({ text: '💡 Getting tips...' });
    const response = await askAI(
      `You are Musico, an expert music producer AI. Give 5 professional, actionable production tips about "${topic}". Be specific, use real techniques and tool names. Format each tip with an emoji and bold title.`
    );
    await respond({ text: response || 'Could not generate tips. Try again!' });
    return;
  }

  // GENERAL
  await respond({ text: '🤔 Thinking...' });
  const response = await askAI(
    `You are Musico, an expert AI assistant for music producers. Answer this question professionally and helpfully: "${input}"`
  );
  await respond({ text: response || 'Could not respond. Try again!' });
});

// ─── APP MENTION ──────────────────────────────────────────
app.event('app_mention', async ({ event, say }) => {
  const input = event.text.replace(/<@[^>]+>/g, '').trim();

  if (!input) {
    await say(getWelcomeMessage());
    return;
  }

  const response = await askAI(
    `You are Musico, an expert AI assistant for music producers. Answer this question professionally: "${input}"`
  );
  await say(`<@${event.user}> ${response || 'Could not respond. Try again!'}`);
});

// ─── DM HANDLER ───────────────────────────────────────────
app.message(async ({ message, say }) => {
  if (message.subtype) return;
  if (!message.text) return;

  // Show welcome if user says hi
  const lower = message.text.toLowerCase();
  if (['hi','hello','hey','start','help'].includes(lower.trim())) {
    await say(getWelcomeMessage());
    return;
  }

  const response = await askAI(
    `You are Musico, an expert AI for music producers. Answer: "${message.text}"`
  );
  await say(response || 'Could not respond. Try again!');
});

// ─── START ────────────────────────────────────────────────
(async () => {
  await app.start();
  console.log('🎛️ Musico is running!');
})();
