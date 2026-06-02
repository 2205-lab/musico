require('dotenv').config();
const axios = require('axios');
const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── MCP SERVER ──────────────────────────────────────────
// Simple HTTP-based MCP server exposing Wavmind tools
// Connects to Claude, GPT and other AI agents via MCP protocol

const http = require('http');

// ─── TOOL DEFINITIONS ────────────────────────────────────
const tools = [
  {
    name: 'search_samples',
    description: 'Search for free Creative Commons audio samples from Freesound.org. Returns sample names, preview links, download links and license info.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords e.g. "trap drums", "piano", "bass"' },
        limit: { type: 'number', description: 'Number of results (max 10)', default: 5 },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_track_features',
    description: 'Get real audio features for any song from Spotify. Returns BPM, key, energy, danceability, loudness and valence.',
    inputSchema: {
      type: 'object',
      properties: {
        track_name: { type: 'string', description: 'Track name and artist e.g. "Blinding Lights - The Weeknd"' },
      },
      required: ['track_name'],
    },
  },
  {
    name: 'analyze_mix',
    description: 'Get professional AI mixing feedback for a music track based on description or audio features.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Description of the mix e.g. "trap beat 140bpm feels muddy in low end"' },
        bpm: { type: 'number', description: 'BPM of the track' },
        key: { type: 'string', description: 'Musical key e.g. "F minor"' },
        energy: { type: 'number', description: 'Energy percentage 0-100' },
        brightness: { type: 'string', description: 'Brightness: Dark, Balanced or Bright' },
        bass_ratio: { type: 'number', description: 'Bass presence percentage 0-100' },
      },
      required: ['description'],
    },
  },
  {
    name: 'get_daw_help',
    description: 'Get step-by-step tutorials for any DAW (Digital Audio Workstation). Powered by real-time web search and AI.',
    inputSchema: {
      type: 'object',
      properties: {
        daw: { type: 'string', description: 'DAW name e.g. "FL Studio", "Ableton Live", "Logic Pro"' },
        question: { type: 'string', description: 'What you need help with e.g. "how to sidechain 808"' },
      },
      required: ['daw', 'question'],
    },
  },
  {
    name: 'compare_artists',
    description: 'Compare two music artists production styles using real Spotify audio data.',
    inputSchema: {
      type: 'object',
      properties: {
        artist1: { type: 'string', description: 'First artist name' },
        artist2: { type: 'string', description: 'Second artist name' },
      },
      required: ['artist1', 'artist2'],
    },
  },
  {
    name: 'get_track_ideas',
    description: 'Generate creative track title ideas and production concepts for a given genre or mood.',
    inputSchema: {
      type: 'object',
      properties: {
        genre: { type: 'string', description: 'Genre or mood e.g. "dark trap", "lo-fi", "cinematic"' },
      },
      required: ['genre'],
    },
  },
];

// ─── SPOTIFY HELPERS ─────────────────────────────────────
async function getSpotifyToken() {
  const res = await axios.post('https://accounts.spotify.com/api/token', 'grant_type=client_credentials', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET).toString('base64') },
  });
  return res.data.access_token;
}

async function fetchTrackFeatures(trackName) {
  const token = await getSpotifyToken();
  const search = await axios.get('https://api.spotify.com/v1/search', { headers: { Authorization: `Bearer ${token}` }, params: { q: trackName, type: 'track', limit: 1 } });
  const track = search.data.tracks.items[0];
  if (!track) return null;
  const features = await axios.get(`https://api.spotify.com/v1/audio-features/${track.id}`, { headers: { Authorization: `Bearer ${token}` } });
  const keys = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const modes = ['Minor','Major'];
  return {
    name: track.name, artist: track.artists[0].name,
    bpm: Math.round(features.data.tempo),
    key: keys[features.data.key] + ' ' + modes[features.data.mode],
    energy: Math.round(features.data.energy * 100),
    danceability: Math.round(features.data.danceability * 100),
    loudness: features.data.loudness.toFixed(1),
    valence: Math.round(features.data.valence * 100),
  };
}

async function fetchArtistStats(name) {
  const token = await getSpotifyToken();
  const search = await axios.get('https://api.spotify.com/v1/search', { headers: { Authorization: `Bearer ${token}` }, params: { q: name, type: 'track', limit: 5 } });
  const tracks = search.data.tracks.items;
  if (!tracks.length) return null;
  const featuresRes = await Promise.all(tracks.map(t => axios.get(`https://api.spotify.com/v1/audio-features/${t.id}`, { headers: { Authorization: `Bearer ${token}` } })));
  const features = featuresRes.map(r => r.data);
  const avg = (key) => Math.round(features.reduce((sum, f) => sum + f[key], 0) / features.length);
  const keys = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  return { name, bpm: avg('tempo'), energy: Math.round(avg('energy')), danceability: Math.round(avg('danceability')), valence: Math.round(avg('valence')), loudness: (features.reduce((s,f) => s+f.loudness,0)/features.length).toFixed(1), key: keys[Math.abs(avg('key'))%12] + ' ' + ['Minor','Major'][avg('mode')>0?1:0] };
}

// ─── FREESOUND HELPER ─────────────────────────────────────
async function fetchFreesound(query, limit = 5) {
  const clean = query.replace(/\b(loop|loops|sample|samples)\b/gi,'').trim().split(' ').slice(0,3).join(' ');
  const url = `https://freesound.org/apiv2/search/text/?query=${encodeURIComponent(clean||query)}&token=${process.env.FREESOUND_API_KEY}&format=json&page_size=${Math.min(limit,10)}&fields=id,name,tags,duration,license,username,previews,avg_rating,num_downloads`;
  const res = await axios.get(url, { timeout: 10000 });
  return (res.data.results||[]).map(s => ({
    name: s.name, duration: Math.round((s.duration||0)*10)/10,
    license: s.license?.includes('publicdomain') ? 'CC0 Free' : 'CC Attribution',
    username: s.username,
    preview_url: s.previews?.['preview-hq-mp3']||null,
    download_url: `https://freesound.org/people/${s.username}/sounds/${s.id}/`,
    rating: s.avg_rating ? Math.round(s.avg_rating*10)/10 : 0,
    downloads: s.num_downloads||0,
    tags: (s.tags||[]).slice(0,6).join(', '),
  }));
}

// ─── TAVILY HELPER ────────────────────────────────────────
async function fetchTavily(query) {
  const res = await axios.post('https://api.tavily.com/search', { api_key: process.env.TAVILY_API_KEY, query, search_depth: 'basic', max_results: 3, include_answer: true }, { timeout: 10000 });
  return { answer: res.data.answer||null, sources: (res.data.results||[]).map(r => ({ title: r.title, url: r.url })) };
}

// ─── GROQ HELPER ─────────────────────────────────────────
async function askAI(prompt) {
  const res = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [{ role: 'system', content: 'You are Wavmind, expert AI for music producers. Be specific and professional.' }, { role: 'user', content: prompt }],
    max_tokens: 1024,
  });
  return res.choices[0].message.content;
}

// ─── TOOL EXECUTION ──────────────────────────────────────
async function executeTool(name, args) {
  switch (name) {

    case 'search_samples': {
      const sounds = await fetchFreesound(args.query, args.limit || 5);
      if (!sounds.length) return { error: `No samples found for "${args.query}". Try simpler keywords.` };
      return { query: args.query, count: sounds.length, samples: sounds };
    }

    case 'get_track_features': {
      const features = await fetchTrackFeatures(args.track_name);
      if (!features) return { error: `Could not find "${args.track_name}" on Spotify.` };
      return features;
    }

    case 'analyze_mix': {
      const prompt = `Professional mixing feedback for:
Description: ${args.description}
${args.bpm ? `BPM: ${args.bpm}` : ''}
${args.key ? `Key: ${args.key}` : ''}
${args.energy ? `Energy: ${args.energy}%` : ''}
${args.brightness ? `Brightness: ${args.brightness}` : ''}
${args.bass_ratio ? `Bass: ${args.bass_ratio}%` : ''}
Give specific EQ, compression, arrangement advice. Use real plugin names.`;
      const feedback = await askAI(prompt);
      return { description: args.description, feedback };
    }

    case 'get_daw_help': {
      const [tavily, ai] = await Promise.all([
        fetchTavily(`${args.daw} ${args.question} tutorial`),
        askAI(`Expert ${args.daw} tutorial: "${args.question}". Give numbered steps.`),
      ]);
      return { daw: args.daw, question: args.question, ai_answer: ai, web_answer: tavily.answer, sources: tavily.sources };
    }

    case 'compare_artists': {
      const [s1, s2] = await Promise.all([fetchArtistStats(args.artist1), fetchArtistStats(args.artist2)]);
      if (!s1 || !s2) return { error: 'Could not find one or both artists on Spotify.' };
      const analysis = await askAI(`Compare ${s1.name} (BPM ${s1.bpm}, Energy ${s1.energy}%, Key ${s1.key}) vs ${s2.name} (BPM ${s2.bpm}, Energy ${s2.energy}%, Key ${s2.key}). Key differences, how to blend.`);
      return { artist1: s1, artist2: s2, analysis };
    }

    case 'get_track_ideas': {
      const ideas = await askAI(`Generate 5 creative track title ideas with concepts for "${args.genre}". Format: Title — concept.`);
      return { genre: args.genre, ideas };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─── MCP HTTP SERVER ─────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      // MCP Endpoint: List tools
      if (req.method === 'GET' && req.url === '/mcp/tools') {
        res.writeHead(200);
        res.end(JSON.stringify({ tools }));
        return;
      }

      // MCP Endpoint: Execute tool
      if (req.method === 'POST' && req.url === '/mcp/execute') {
        const { tool, arguments: args } = JSON.parse(body);
        console.log(`MCP Tool called: ${tool}`, args);
        const result = await executeTool(tool, args);
        res.writeHead(200);
        res.end(JSON.stringify({ tool, result }));
        return;
      }

      // Health check
      if (req.url === '/health') {
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ok', service: 'Wavmind MCP Server', tools: tools.map(t => t.name) }));
        return;
      }

      // MCP manifest (for Claude Desktop and other clients)
      if (req.url === '/mcp') {
        res.writeHead(200);
        res.end(JSON.stringify({
          name: 'wavmind',
          version: '1.0.0',
          description: 'Wavmind MCP Server — AI tools for music producers',
          tools: tools.map(t => ({ name: t.name, description: t.description })),
          endpoints: {
            list_tools: 'GET /mcp/tools',
            execute_tool: 'POST /mcp/execute',
          },
        }));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));

    } catch (err) {
      console.error('MCP Server error:', err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  });
});

const MCP_PORT = process.env.MCP_PORT || 3001;
server.listen(MCP_PORT, () => {
  console.log(`🔌 Wavmind MCP Server running on port ${MCP_PORT}`);
  console.log(`📋 Tools: ${tools.map(t => t.name).join(', ')}`);
});

module.exports = { executeTool, tools };
