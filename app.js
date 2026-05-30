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
  const filePath = path.join(tmpDir, filename);

  try {
    // Download file from Slack
    const response = await axios.get(fileUrl, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      responseType: 'arraybuffer',
    });

    fs.writeFileSync(filePath, response.data);

    // Run Python Librosa analysis
    const result = execSync(`python3 analyze.py "${filePath}"`).toString();
    const analysis = JSON.parse(result);

    // Clean up temp file
    fs.unlinkSync(filePath);

    return analysis;
  } catch (err) {
    console.error('Audio analysis error:', err.message);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return null;
  }
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
      text: `🎵 *Analyzing "${file.name}"...*\nRunning BPM detection, key analysis, and frequency scan. This takes about 10 seconds...`,
    });

    const analysis = await analyzeAudioFile(file.url_private_download, file.name);

    if (!analysis || analysis.error) {
      await client.chat.postMessage({
        channel: event.channel_id,
        text: `❗ Could not analyze "${file.name}". Make sure it's a valid audio file (MP3, WAV, FLAC).`,
      });
      return;
    }

    // Get AI mixing feedback based on real analysis
    const feedback = await askAI(
      `You are Musico, a professional mixing engineer. A producer just uploaded a track with these real audio analysis results:
      
BPM: ${analysis.bpm}
Key: ${analysis.key}
Energy: ${analysis.energy}%
Brightness: ${analysis.brightness}
Bass ratio: ${analysis.bass_ratio}%
Danceability: ${analysis.danceability}%
Duration: ${analysis.duration} seconds

Give them specific, professional mixing feedback based on these exact numbers. Include:
- What the BPM and key suggest about the genre
- Whether the energy level is appropriate
- Specific EQ advice based on the brightness and bass ratio
- Compression and dynamics suggestions
- What to improve to make it more professional

Be specific, use real numbers, and format with emojis and clear sections.`
    );

    await client.chat.postMessage({
      channel: event.channel_id,
      text: `🎛️ *Analysis Complete: ${file.name}*

📊 *Audio Data:*
- BPM: ${analysis.bpm}
- Key: ${analysis.key}
- Energy: ${analysis.energy}%
- Brightness: ${analysis.brightness}
- Bass presence: ${analysis.bass_ratio}%
- Danceability: ${analysis.danceability}%
- Duration: ${Math.floor(analysis.duration / 60)}:${String(analysis.duration % 60).padStart(2, '0')}

🤖 *AI Mixing Feedback:*

${feedback || 'Could not generate feedback. Try again!'}`,
    });

  } catch (err) {
    console.error('File handler error:', err.message);
  }
});

// ─── SLASH COMMANDS ───────────────────────────────────────
app.command('/musico', async ({ command, ack, respond }) => {
  await ack();
  const input = command.text.trim();

  if (!input) {
    await respond({
      text: `🎛️ *Welcome to Musico!*\n\nHere's what I can do:\n\n• \`/musico ideas [genre/mood]\` — Generate track ideas\n• \`/musico feedback [describe your mix]\` — Get mixing feedback\n• \`/musico reference [track - artist]\` — Analyze a reference track with real Spotify data\n• \`/musico bpm [mood or genre]\` — Get BPM, key & chord suggestions\n• \`/musico tips [topic]\` — Get production tips\n• \`/musico chords [key + genre]\` — Get chord progressions\n\n🎵 *Or upload any MP3/WAV file and I'll analyze it automatically!*\n\nOr just \`@Musico\` and ask me anything!`,
    });
    return;
  }

  const lower = input.toLowerCase();

  if (lower.startsWith('ideas')) {
    const genre = input.slice(5).trim() || 'general';
    await respond({ text: '🎵 Generating track ideas...' });
    const response = await askAI(
      `You are Musico, an expert AI music producer assistant. Generate 5 creative track title ideas with brief concept descriptions for: "${genre}". Format each as: 🎵 *Title* — concept description.`
    );
    await respond({ text: response || 'Could not generate ideas. Try again!' });
    return;
  }

  if (lower.startsWith('feedback')) {
    const description = input.slice(8).trim();
    if (!description) {
      await respond({ text: '❗ Please describe your mix. Example: `/musico feedback My trap beat at 140bpm feels muddy`' });
      return;
    }
    await respond({ text: '🎚️ Analyzing your mix...' });
    const response = await askAI(
      `You are Musico, a professional mixing engineer AI. Give detailed mixing feedback for: "${description}". Include advice on EQ, compression, stereo width, frequency balance. Use emojis and clear sections.`
    );
    await respond({ text: response || 'Could not analyze. Try again!' });
    return;
  }

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
        `You are Musico, a professional mixing engineer. Give advice on achieving the sound of this track:\n\nTrack: ${features.name} by ${features.artist}\nBPM: ${features.bpm}\nKey: ${features.key}\nEnergy: ${features.energy}%\nDanceability: ${features.danceability}%\nLoudness: ${features.loudness} dB\nValence: ${features.valence}%\n\nCover: tempo, key, energy, mixing targets, and overall vibe.`
      );
      await respond({
        text: `🎵 *${features.name} by ${features.artist}*\n\n📊 *Real Spotify Data:*\n• BPM: ${features.bpm}\n• Key: ${features.key}\n• Energy: ${features.energy}%\n• Danceability: ${features.danceability}%\n• Loudness: ${features.loudness} dB\n• Valence: ${features.valence}%\n\n🎛️ *How to achieve this sound:*\n\n${response || 'Could not generate advice. Try again!'}`,
      });
    } else {
      const response = await askAI(
        `You are Musico, a professional mixing engineer. Give detailed advice on achieving the sound of "${trackQuery}".`
      );
      await respond({ text: `🎛️ *Reference: ${trackQuery}*\n\n${response || 'Could not analyze. Try again!'}` });
    }
    return;
  }

  if (lower.startsWith('bpm')) {
    const mood = input.slice(3).trim() || 'general';
    await respond({ text: '🥁 Calculating suggestions...' });
    const response = await askAI(
      `You are Musico, an expert music producer AI. For "${mood}", suggest: ideal BPM range, best keys, chord progressions, and typical song structure. Be specific with numbers.`
    );
    await respond({ text: response || 'Could not generate. Try again!' });
    return;
  }

  if (lower.startsWith('chords')) {
    const query = input.slice(6).trim() || 'C minor trap';
    await respond({ text: '🎹 Generating chord progressions...' });
    const response = await askAI(
      `You are Musico, an expert music theory AI for producers. Generate 3 chord progressions for: "${query}". For each progression show: the chords, Roman numeral analysis, and the emotional feel. Also suggest a melody note that works over each chord.`
    );
    await respond({ text: response || 'Could not generate chords. Try again!' });
    return;
  }

  if (lower.startsWith('tips')) {
    const topic = input.slice(4).trim() || 'music production';
    await respond({ text: '💡 Getting tips...' });
    const response = await askAI(
      `You are Musico, an expert music producer AI. Give 5 professional production tips about "${topic}". Use real techniques and tool names. Format with emojis and bold titles.`
    );
    await respond({ text: response || 'Could not generate tips. Try again!' });
    return;
  }

  await respond({ text: '🤔 Thinking...' });
  const response = await askAI(
    `You are Musico, an expert AI assistant for music producers. Answer professionally: "${input}"`
  );
  await respond({ text: response || 'Could not respond. Try again!' });
});

// ─── MENTIONS & DMs ───────────────────────────────────────
app.event('app_mention', async ({ event, say }) => {
  const input = event.text.replace(/<@[^>]+>/g, '').trim();
  if (!input) {
    await say(`Hey <@${event.user}>! 🎛️ Ask me anything about music production! Or upload an MP3/WAV and I'll analyze it!`);
    return;
  }
  const response = await askAI(
    `You are Musico, an expert AI assistant for music producers. Answer: "${input}"`
  );
  await say(`<@${event.user}> ${response || 'Could not respond. Try again!'}`);
});

app.message(async ({ message, say }) => {
  if (message.subtype) return;
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
