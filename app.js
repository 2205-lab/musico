require('dotenv').config();
const { App } = require('@slack/bolt');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

// Initialize Slack app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

// ─── SPOTIFY TOKEN ───────────────────────────────────────
async function getSpotifyToken() {
  const res = await axios.post(
    'https://accounts.spotify.com/api/token',
    'grant_type=client_credentials',
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization:
          'Basic ' +
          Buffer.from(
            process.env.SPOTIFY_CLIENT_ID +
              ':' +
              process.env.SPOTIFY_CLIENT_SECRET
          ).toString('base64'),
      },
    }
  );
  return res.data.access_token;
}

// ─── SPOTIFY SEARCH ──────────────────────────────────────
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
    const modes = ['Minor', 'Major'];

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

// ─── GEMINI AI ────────────────────────────────────────────
async function askGemini(prompt) {
  try {
    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (err) {
    console.error('Gemini error:', err.message);
    return 'Sorry, AI is unavailable right now. Try again in a moment.';
  }
}

// ─── /musico COMMAND ─────────────────────────────────────
app.command('/musico', async ({ command, ack, respond }) => {
  await ack();

  const input = command.text.trim();

  if (!input) {
    await respond({
      text: `🎛️ *Welcome to Musico!*\n\nHere's what I can do:\n\n• \`/musico ideas [genre/mood]\` — Generate track ideas\n• \`/musico feedback [describe your mix]\` — Get mixing feedback\n• \`/musico reference [track name - artist]\` — Analyze a reference track\n• \`/musico bpm [mood or genre]\` — Get BPM, key & chord suggestions\n• \`/musico tips [topic]\` — Get production tips\n\nOr just \`@Musico\` and ask me anything! 🎵`,
    });
    return;
  }

  const lower = input.toLowerCase();

  // IDEAS
  if (lower.startsWith('ideas')) {
    const genre = input.slice(5).trim() || 'general';
    await respond({ text: '🎵 Generating track ideas...' });
    const response = await askGemini(
      `You are Musico, an expert AI music producer assistant. Generate 5 creative and unique track title ideas with brief concept descriptions for this genre/mood: "${genre}". Format each as: 🎵 *Title* — concept description. Be specific and inspiring.`
    );
    await respond({ text: response });
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
    const response = await askGemini(
      `You are Musico, a professional mixing engineer and music producer AI. Give detailed, actionable mixing feedback for this track description: "${description}". Include specific advice on: EQ, compression, stereo width, frequency balance, and arrangement. Use music production terminology. Format with clear sections using emojis.`
    );
    await respond({ text: response });
    return;
  }

  // REFERENCE TRACK
  if (lower.startsWith('reference')) {
    const trackQuery = input.slice(9).trim();
    if (!trackQuery) {
      await respond({ text: '❗ Please provide a track name. Example: `/musico reference Blinding Lights - The Weeknd`' });
      return;
    }
    await respond({ text: `🔍 Looking up "${trackQuery}" on Spotify...` });

    const features = await getTrackFeatures(trackQuery);

    if (features) {
      const spotifyInfo = `Track: ${features.name} by ${features.artist}\nBPM: ${features.bpm}\nKey: ${features.key}\nEnergy: ${features.energy}%\nDanceability: ${features.danceability}%\nLoudness: ${features.loudness} dB\nValence (happiness): ${features.valence}%`;

      const response = await askGemini(
        `You are Musico, a professional mixing engineer. A music producer wants to achieve the sound of this reference track. Here are its real Spotify audio features:\n\n${spotifyInfo}\n\nGive detailed, actionable advice on how to achieve this sound in their own production. Cover: tempo and groove, key and harmonic choices, energy and arrangement, mixing targets (loudness, EQ), and overall vibe. Be specific and professional.`
      );

      await respond({
        text: `🎵 *Reference: ${features.name} by ${features.artist}*\n\n📊 *Real Spotify Data:*\n• BPM: ${features.bpm}\n• Key: ${features.key}\n• Energy: ${features.energy}%\n• Danceability: ${features.danceability}%\n• Loudness: ${features.loudness} dB\n• Valence: ${features.valence}%\n\n🎛️ *How to achieve this sound:*\n\n${response}`,
      });
    } else {
      const response = await askGemini(
        `You are Musico, a professional mixing engineer. Give detailed advice on how to achieve the sound of "${trackQuery}". Cover: tempo and groove, key and harmonic choices, energy and arrangement, mixing approach, and overall vibe. Be specific and professional.`
      );
      await respond({ text: `🎛️ *Reference Analysis: ${trackQuery}*\n\n${response}` });
    }
    return;
  }

  // BPM
  if (lower.startsWith('bpm')) {
    const mood = input.slice(3).trim() || 'general';
    await respond({ text: '🥁 Calculating BPM and key suggestions...' });
    const response = await askGemini(
      `You are Musico, an expert music producer AI. For the mood/genre "${mood}", suggest: the ideal BPM range, the best musical keys, chord progressions that work well, and the typical song structure. Format with clear sections and be specific with numbers.`
    );
    await respond({ text: response });
    return;
  }

  // TIPS
  if (lower.startsWith('tips')) {
    const topic = input.slice(4).trim() || 'general music production';
    await respond({ text: '💡 Getting production tips...' });
    const response = await askGemini(
      `You are Musico, an expert music producer AI. Give 5 professional, actionable production tips about "${topic}". Be specific, use real techniques and tool names that producers use. Format each tip with an emoji and bold title.`
    );
    await respond({ text: response });
    return;
  }

  // GENERAL QUESTION
  await respond({ text: '🤔 Thinking...' });
  const response = await askGemini(
    `You are Musico, an expert AI assistant for music producers. Answer this question professionally and helpfully: "${input}"`
  );
  await respond({ text: response });
});

// ─── @MENTION HANDLER ─────────────────────────────────────
app.event('app_mention', async ({ event, say }) => {
  const input = event.text.replace(/<@[^>]+>/g, '').trim();
  if (!input) {
    await say(`Hey <@${event.user}>! 🎛️ Ask me anything about music production!`);
    return;
  }
  const response = await askGemini(
    `You are Musico, an expert AI assistant for music producers. Answer this question professionally: "${input}"`
  );
  await say(`<@${event.user}> ${response}`);
});

// ─── DM HANDLER ───────────────────────────────────────────
app.message(async ({ message, say }) => {
  if (message.subtype) return;
  const response = await askGemini(
    `You are Musico, an expert AI assistant for music producers. Answer this question professionally: "${message.text}"`
  );
  await say(response);
});

// ─── START ────────────────────────────────────────────────
(async () => {
  await app.start();
  console.log('🎛️ Musico is running!');
})();
