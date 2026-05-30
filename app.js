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
    console.log('Downloading file from Slack:', fileUrl);

    // Download file from Slack
    const response = await axios.get(fileUrl, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      responseType: 'arraybuffer',
      timeout: 30000,
    });

    fs.writeFileSync(filePath, response.data);
    console.log('File saved to:', filePath);
    console.log('File size:', fs.statSync(filePath).size, 'bytes');

    // Run Python Librosa analysis
    console.log('Running Python analysis...');
    const result = execSync(
      `python3 analyze.py "${filePath}"`,
      { timeout: 60000 }
    ).toString().trim();

    console.log('Python result:', result);
    const analysis = JSON.parse(result);

    // Clean up
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    return analysis;

  } catch (err) {
    console.error('Audio analysis error:', err.message);
    if (err.stdout) console.error('Python stdout:', err.stdout.toString());
    if (err.stderr) console.error('Python stderr:', err.stderr.toString());
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { error: err.message };
  }
}

// ─── FILE UPLOAD HANDLER ─────────────────────────────────
app.event('file_shared', async ({ event, client }) => {
  try {
    console.log('File shared event received:', event);

    const fileInfo = await client.files.info({ file: event.file_id });
    const file = fileInfo.file;

    console.log('File info:', file.name, file.mimetype, file.size);

    const audioTypes = ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg'];
    const ext = file.name.split('.').pop().toLowerCase();

    if (!audioTypes.includes(ext)) {
      console.log('Not an audio file, skipping:', ext);
      return;
    }

    await client.chat.postMessage({
      channel: event.channel_id,
      text: `🎵 *Analyzing "${file.name}"...*\nRunning BPM detection, key analysis, and frequency scan. This takes about 15 seconds...`,
    });

    const analysis = await analyzeAudioFile(
      file.url_private_download,
      file.name
    );

    if (!analysis || analysis.error) {
      console.error('Analysis failed:', analysis);
      await client.chat.postMessage({
        channel: event.channel_id,
        text: `❗ Analysis failed for "${file.name}".\nError: ${analysis?.error || 'Unknown error'}\n\nTry uploading a smaller file (under 10MB) or use MP3 format.`,
      });
      return;
    }

    // Get AI mixing feedback
    const feedback = await askAI(
      `You are Musico, a professional mixing engineer. A producer uploaded a track with these real audio analysis results:

BPM: ${analysis.bpm}
Key: ${analysis.key}
Energy: ${analysis.energy}%
Brightness: ${analysis.brightness}
Bass ratio: ${analysis.bass_ratio}%
Danceability: ${analysis.danceability}%
Duration: ${analysis.duration} seconds

Give specific, professional mixing feedback based on these exact numbers. Include:
- What the BPM and key suggest about the genre and mood
- Whether the energy level is appropriate and how to adjust it
- Specific EQ advice based on the brightness and bass ratio
- Compression and dynamics suggestions
- 3 specific things to improve to make it more professional

Be specific, use real numbers and plugin/technique names. Format with emojis and clear sections.`
    );

    await client.chat.postMessage({
      channel: event.channel_id,
      text: `🎛️ *Analysis Complete: ${file.name}*

📊 *Real Audio Data:*
- 🥁 BPM: *${analysis.bpm}*
- 🎵 Key: *${analysis.key}*
- ⚡ Energy: *${analysis.energy}%*
- 🌈 Brightness: *${analysis.brightness}*
- 🔊 Bass presence: *${analysis.bass_ratio}%*
- 💃 Danceability: *${analysis.danceability}%*
- ⏱️ Duration: *${Math.floor(analysis.duration / 60)}:${String(analysis.duration % 60).padStart(2, '0')}*

🤖 *AI Mixing Feedback:*

${feedback || 'Could not generate feedback. Try again!'}

_Tip: Use \`/musico reference [track name]\` to compare with a professional mix!_`,
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

  if (!input) {
    await respond({
      text: `🎛️ *Welcome to Musico — AI Assistant for Music Producers!*

Here's what I can do:

🎵 \`/musico ideas [genre/mood]\` — Generate track title ideas
🎚️ \`/musico feedback [describe your mix]\` — Get mixing feedback
🔍 \`/musico reference [track - artist]\` — Analyze a reference track with real Spotify data
🥁 \`/musico bpm [mood or genre]\` — Get BPM, key & chord suggestions
🎹 \`/musico chords [key + genre]\` — Get chord progressions with music theory
💡 \`/musico tips [topic]\` — Get production tips

🎵 *Upload any MP3 or WAV file and I'll automatically analyze BPM, key, energy and give you mixing feedback!*

Or just \`@Musico\` and ask me anything about music production!`,
    });
    return;
  }

  const lower = input.toLowerCase();

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
      await respond({ text: '❗ Please describe your mix. Example: `/musico feedback My trap beat at 140bpm feels muddy in the low end`' });
      return;
    }
    await respond({ text: '🎚️ Analyzing your mix...' });
    const response = await askAI(
      `You are Musico, a professional mixing engineer AI. Give detailed, actionable mixing feedback for this track description: "${description}". Include specific advice on: EQ frequencies, compression settings, stereo width, frequency balance, and arrangement. Use music production terminology. Format with clear sections using emojis.`
    );
    await respond({ text: response || 'Could not analyze. Try again!' });
    return;
  }

  // REFERENCE
  if (lower.startsWith('reference')) {
    const trackQuery = input.slice(9).trim();
    if (!trackQuery) {
      await respond({ text: '❗ Example: `/musico reference Blinding Lights - The Weeknd`' });
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
Valence (happiness): ${features.valence}%

Cover: tempo and groove approach, key and harmonic choices, energy and arrangement, mixing targets, and overall vibe. Be specific and professional.`
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
      await respond({ text: `🎛️ *Reference: ${trackQuery}*\n\n${response || 'Could not analyze. Try again!'}` });
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
    await say(`Hey <@${event.user}>! 🎛️ Ask me anything about music production! Or upload an MP3/WAV and I'll analyze it automatically!`);
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
