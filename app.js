require('dotenv').config();
const { App } = require('@slack/bolt');
const Groq = require('groq-sdk');
const axios = require('axios');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

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
      const spotifyInfo = `Track: ${features.name} by ${features.artist}\nBPM: ${features.bpm}\nKey: ${features.key}\nEnergy: ${features.energy}%\nDanceability: ${features.danceability}%\nLoudness: ${features.loudness} dB\nValence: ${features.valence}%`;
      const response = await askAI(
        `You are Musico, a professional mixing engineer. Give advice on achieving the sound of this track based on its real Spotify data:\n\n${spotifyInfo}\n\nCover: tempo, key, energy, mixing targets, and overall vibe. Be specific and professional.`
      );
      await respond({
        text: `🎵 *${features.name} by ${features.artist}*\n\n📊 *Spotify Data:*\n• BPM: ${features.bpm}\n• Key: ${features.key}\n• Energy: ${features.energy}%\n• Danceability: ${features.danceability}%\n• Loudness: ${features.loudness} dB\n• Valence: ${features.valence}%\n\n🎛️ *How to achieve this sound:*\n\n${response || 'Could not generate advice. Try again!'}`,
      });
    } else {
      const response = await askAI(
        `You are Musico, a professional mixing engineer. Give detailed advice on achieving the sound of "${trackQuery}". Cover tempo, key, mixing approach, and vibe.`
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

app.event('app_mention', async ({ event, say }) => {
  const input = event.text.replace(/<@[^>]+>/g, '').trim();
  if (!input) {
    await say(`Hey <@${event.user}>! 🎛️ Ask me anything about music production!`);
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

(async () => {
  await app.start();
  console.log('🎛️ Musico is running!');
})();
