require('dotenv').config();
const { App } = require('@slack/bolt');
const Groq = require('groq-sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const http = require('http');

const app = new App({
 token: process.env.SLACK_BOT_TOKEN,
 signingSecret: process.env.SLACK_SIGNING_SECRET,
 socketMode: true,
 appToken: process.env.SLACK_APP_TOKEN,
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── PERSISTENT STORAGE ───────────────────────────────────
const REMINDERS_FILE = '/tmp/wavmind_reminders.json';
const STATS_FILE = '/tmp/wavmind_stats.json';
const PROJECTS_FILE = '/tmp/wavmind_projects.json';

global._memoryStore = global._memoryStore || {
 reminders: {},
 stats: {},
 projects: {},
};

function loadFile(file, memKey) {
 if (Object.keys(global._memoryStore[memKey]).length > 0) {
   return global._memoryStore[memKey];
 }
 try {
   if (fs.existsSync(file)) {
     const data = JSON.parse(fs.readFileSync(file, 'utf8'));
     global._memoryStore[memKey] = data;
     return data;
   }
 } catch (err) { console.error(`Load error ${file}:`, err.message); }
 return {};
}

function saveFile(file, data, memKey) {
 global._memoryStore[memKey] = data;
 try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
 catch (err) { console.error(`Save error ${file}:`, err.message); }
}

global.pendingReminders = loadFile(REMINDERS_FILE, 'reminders');
global.weeklyStats = loadFile(STATS_FILE, 'stats');
global.userProjects = loadFile(PROJECTS_FILE, 'projects');
global.userUploads = global.userUploads || {};
global.samplePageTracker = global.samplePageTracker || {};

// ─── PROJECT MANAGEMENT ───────────────────────────────────
function createProject(userId, name) {
 if (!global.userProjects[userId]) global.userProjects[userId] = [];
 const project = {
   id: Date.now().toString(),
   name,
   createdAt: new Date().toISOString(),
   sessions: {
     recording: { done: false, deadline: null, notified: false },
     mixing: { done: false, deadline: null, notified: false },
     mastering: { done: false, deadline: null, notified: false },
     artwork: { done: false, deadline: null, notified: false },
     release: { done: false, deadline: null, notified: false },
   },
   completed: false,
 };
 global.userProjects[userId].push(project);
 saveFile(PROJECTS_FILE, global.userProjects, 'projects');
 return project;
}

function getProjects(userId) { return global.userProjects[userId] || []; }

function getActiveProject(userId) {
 return getProjects(userId).find(p => !p.completed) || null;
}

function updateProjectSession(userId, projectId, sessionType, data) {
 const project = (global.userProjects[userId] || []).find(p => p.id === projectId);
 if (!project) return null;
 project.sessions[sessionType] = { ...project.sessions[sessionType], ...data };
 saveFile(PROJECTS_FILE, global.userProjects, 'projects');
 return project;
}

function markSessionDone(userId, projectId, sessionType) {
 return updateProjectSession(userId, projectId, sessionType, { done: true });
}

function setSessionDeadline(userId, projectId, sessionType, deadline) {
 return updateProjectSession(userId, projectId, sessionType, { deadline, notified: false });
}

function completeProject(userId, projectId) {
 const project = (global.userProjects[userId] || []).find(p => p.id === projectId);
 if (!project) return null;
 project.completed = true;
 saveFile(PROJECTS_FILE, global.userProjects, 'projects');
 return project;
}

function getProjectHealth(project) {
 const sessions = Object.values(project.sessions);
 const done = sessions.filter(s => s.done).length;
 const total = sessions.length;
 return { done, total, percent: Math.round((done / total) * 100) };
}

function scoreBar(percent) {
 const filled = Math.round(percent / 10);
 const color = percent >= 80 ? '🟢' : percent >= 50 ? '🟡' : '🔴';
 return color.repeat(filled) + '⚪'.repeat(10 - filled) + ` ${percent}%`;
}

function daysUntil(dateStr) {
 if (!dateStr) return null;
 return Math.ceil((new Date(dateStr) - new Date()) / (1000 * 60 * 60 * 24));
}

function deadlineEmoji(days) {
 if (days === null) return '📅';
 if (days < 0) return '🔴';
 if (days <= 2) return '🔴';
 if (days <= 7) return '🟡';
 return '🟢';
}

function sessionLabel(key) {
 const labels = { recording: '🎙️ Recording', mixing: '🎚️ Mixing', mastering: '🔊 Mastering', artwork: '🎨 Artwork', release: '🚀 Release' };
 return labels[key] || key;
}

function trackUpload(userId, filename, analysis) {
 if (!global.pendingReminders[userId]) global.pendingReminders[userId] = [];
 global.pendingReminders[userId].push({
   filename, analysis,
   uploadedAt: new Date().toISOString(),
   remindAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
   sent: false,
 });
 saveFile(REMINDERS_FILE, global.pendingReminders, 'reminders');
 if (!global.userUploads[userId]) global.userUploads[userId] = [];
 global.userUploads[userId].push({ filename, analysis, timestamp: new Date().toISOString() });
 if (!global.weeklyStats[userId]) global.weeklyStats[userId] = { tracks: 0, issues: [] };
 global.weeklyStats[userId].tracks++;
 if (analysis.energy < 50) global.weeklyStats[userId].issues.push('Low energy');
 if (analysis.bass_ratio > 65) global.weeklyStats[userId].issues.push('Heavy bass');
 if (analysis.bass_ratio < 20) global.weeklyStats[userId].issues.push('Thin bass');
 saveFile(STATS_FILE, global.weeklyStats, 'stats');
}

// ─── GROQ AI ─────────────────────────────────────────────
async function askAI(prompt) {
 try {
   const response = await groq.chat.completions.create({
     model: 'llama-3.1-8b-instant',
     messages: [
       { role: 'system', content: 'You are Wavmind, an expert AI assistant for music producers. Format using Slack mrkdwn. Use *text* for bold. Use • for bullets. Never use ** or # headers. Keep responses clean and scannable.' },
       { role: 'user', content: prompt },
     ],
     max_tokens: 1024,
   });
   let text = response.choices[0].message.content;
   text = text.replace(/#{1,6}\s+/g, '');
   text = text.replace(/\*\*([^*]+)\*\*/g, '*$1*');
   text = text.replace(/^-\s+/gm, '• ');
   return text;
 } catch (err) { console.error('Groq error:', err.message); return null; }
}

// ─── CONVERSATIONAL AI ────────────────────────────────────
async function conversationalAI(userMessage) {
 const lower = userMessage.toLowerCase();
 if (lower.includes('project') || lower.includes('deadline') || lower.includes('session')) return { type: 'project', message: userMessage };
 if (lower.includes('compare') || lower.includes('reference track') || lower.includes('vs reference')) return { type: 'compare' };
 if (lower.includes('sample') || lower.includes('drum') || lower.includes('piano') || lower.includes('bass') || lower.includes('guitar') || lower.includes('synth') || lower.includes('sound') || lower.includes('loop') || lower.includes('find me') || lower.includes('search for')) return { type: 'samples', query: userMessage.replace(/find|search|get|i need|show me|give me|looking for|find me|search for/gi, '').trim() };
 if (lower.includes('mix') && (lower.includes('feedback') || lower.includes('help') || lower.includes('advice') || lower.includes('muddy') || lower.includes('sound') || lower.includes('feels'))) return { type: 'feedback', message: userMessage };
 if (lower.includes('fl studio') || lower.includes('ableton') || lower.includes('logic') || lower.includes('pro tools') || lower.includes('cubase') || lower.includes('daw') || lower.includes('sidechain') || lower.includes('warp') || lower.includes('how to') || lower.includes('how do i')) return { type: 'daw', message: userMessage };
 if (lower.includes('chord') || lower.includes('progression')) return { type: 'chords', message: userMessage };
 if (lower.includes('bpm') || lower.includes('tempo') || lower.includes('key signature')) return { type: 'bpm', message: userMessage };
 if (lower.includes('idea') || lower.includes('concept') || lower.includes('what should i make') || lower.includes('suggest')) return { type: 'ideas', message: userMessage };
 if (lower.includes('label') || lower.includes('a&r') || lower.includes('commercial') || lower.includes('evaluate my')) return { type: 'label', message: userMessage };
 return { type: 'general', message: userMessage };
}

// ─── TAVILY ──────────────────────────────────────────────
async function tavilySearch(query) {
 try {
   const res = await axios.post('https://api.tavily.com/search',
     { api_key: process.env.TAVILY_API_KEY, query, search_depth: 'basic', max_results: 5, include_answer: true },
     { timeout: 10000 }
   );
   return { answer: res.data.answer || null, results: (res.data.results || []).map(r => ({ title: r.title, url: r.url })) };
 } catch (err) { console.error('Tavily error:', err.message); return null; }
}

// ─── FREESOUND ────────────────────────────────────────────
function mapSounds(results) {
 return results.sort(() => Math.random() - 0.5).map(s => ({
   id: s.id, name: s.name,
   duration: Math.round((s.duration || 0) * 10) / 10,
   license: s.license?.includes('publicdomain') ? 'CC0 — Free' : 'CC Attribution',
   username: s.username,
   preview: s.previews?.['preview-hq-mp3'] || s.previews?.['preview-lq-mp3'] || null,
   url: `https://freesound.org/people/${s.username}/sounds/${s.id}/`,
   downloads: s.num_downloads || 0,
   rating: s.avg_rating ? Math.round(s.avg_rating * 10) / 10 : 0,
   tags: (s.tags || []).slice(0, 6).join(' · '),
 }));
}

function buildSearchQuery(query) {
 const stopWords = /\b(loop|loops|sample|samples|pack|packs|free|download|audio)\b/gi;
 let clean = query.replace(stopWords, '').replace(/\s+/g, ' ').trim();
 if (clean.length < 2) clean = query.trim();
 return clean;
}

function enhanceQuery(query) {
 const lower = query.toLowerCase();
 const enhancements = {
   piano: ['piano melody', 'piano chord', 'piano loop', 'piano riff', 'piano notes'],
   synth: ['synth pad', 'synth lead', 'synth bass', 'synthesizer', 'synth arp'],
   bass: ['bass guitar', 'bass line', 'bass riff', '808 bass', 'sub bass'],
   guitar: ['guitar riff', 'guitar chord', 'electric guitar', 'acoustic guitar'],
   drums: ['drum loop', 'drum beat', 'drum kit', 'trap drums', 'drum pattern'],
   strings: ['string ensemble', 'violin', 'cello', 'string melody', 'orchestral strings'],
   flute: ['flute melody', 'flute loop', 'pan flute', 'flute notes'],
   trumpet: ['trumpet melody', 'brass', 'trumpet loop', 'trumpet riff'],
   saxophone: ['saxophone jazz', 'sax melody', 'alto sax', 'saxophone riff'],
   violin: ['violin melody', 'violin loop', 'violin solo'],
   ambient: ['ambient pad', 'ambient texture', 'ambient drone', 'ambient atmosphere'],
   vocal: ['vocal chop', 'vocal sample', 'vocal melody', 'vocal harmony'],
 };
 for (const [instrument, options] of Object.entries(enhancements)) {
   if (lower.includes(instrument)) return options[Math.floor(Math.random() * options.length)];
 }
 return query;
}

function getNextPage(userId, query) {
 const key = `${userId}_${query.toLowerCase().trim()}`;
 if (!global.samplePageTracker[key]) global.samplePageTracker[key] = [];
 const used = global.samplePageTracker[key];
 let attempts = 0; let page;
 do { page = Math.floor(Math.random() * 8) + 1; attempts++; }
 while (used.includes(page) && attempts < 20);
 used.push(page);
 if (used.length > 6) used.shift();
 global.samplePageTracker[key] = used;
 return page;
}

async function searchFreesound(query, userId = null) {
 try {
   const cleanQuery = buildSearchQuery(query);
   const enhancedQuery = enhanceQuery(cleanQuery);
   const page = userId ? getNextPage(userId, query) : Math.floor(Math.random() * 8) + 1;
   const url = `https://freesound.org/apiv2/search/text/?query=${encodeURIComponent(enhancedQuery)}&token=${process.env.FREESOUND_API_KEY}&format=json&page_size=10&page=${page}&fields=id,name,tags,duration,license,username,previews,avg_rating,num_downloads&filter=duration:[1+TO+30]`;
   const res = await axios.get(url, { timeout: 10000 });
   let results = res.data.results || [];
   if (!results.length && page > 1) {
     const fallback = await axios.get(url.replace(`page=${page}`, 'page=1'), { timeout: 10000 });
     results = fallback.data.results || [];
   }
   if (!results.length) {
     const simple = query.split(' ')[0];
     if (simple !== query) {
       const simpleUrl = `https://freesound.org/apiv2/search/text/?query=${encodeURIComponent(simple)}&token=${process.env.FREESOUND_API_KEY}&format=json&page_size=10&page=1&fields=id,name,tags,duration,license,username,previews,avg_rating,num_downloads&filter=duration:[1+TO+30]`;
       const simpleRes = await axios.get(simpleUrl, { timeout: 10000 });
       results = simpleRes.data.results || [];
     }
   }
   if (!results.length) return null;
   return mapSounds(results);
 } catch (err) { console.error('Freesound error:', err.message); return null; }
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
   const normalizedQuery = trackName.trim().replace(/\s+/g, ' ');
   const search = await axios.get('https://api.spotify.com/v1/search', {
     headers: { Authorization: `Bearer ${token}` },
     params: { q: normalizedQuery, type: 'track', limit: 1, market: 'US' },
   });
   let track = search.data.tracks.items[0];
   if (!track) {
     const simpleName = normalizedQuery.split(/[-–by]/i)[0].trim();
     const retry = await axios.get('https://api.spotify.com/v1/search', {
       headers: { Authorization: `Bearer ${token}` },
       params: { q: simpleName, type: 'track', limit: 1, market: 'US' },
     });
     track = retry.data.tracks.items[0];
     if (!track) return null;
   }
   const features = await axios.get(`https://api.spotify.com/v1/audio-features/${track.id}`, { headers: { Authorization: `Bearer ${token}` } });
   const keys = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
   return {
     name: track.name, artist: track.artists[0].name,
     bpm: Math.round(features.data.tempo),
     key: keys[features.data.key] + ' ' + ['Minor','Major'][features.data.mode],
     energy: Math.round(features.data.energy * 100),
     danceability: Math.round(features.data.danceability * 100),
     loudness: features.data.loudness.toFixed(1),
     valence: Math.round(features.data.valence * 100),
   };
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
   const avg = k => Math.round(features.reduce((s, f) => s + f[k], 0) / features.length);
   const keys = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
   return { name: artistName, bpm: avg('tempo'), energy: Math.round(avg('energy')), danceability: Math.round(avg('danceability')), valence: Math.round(avg('valence')), loudness: (features.reduce((s,f)=>s+f.loudness,0)/features.length).toFixed(1), key: keys[Math.abs(avg('key'))%12] + ' ' + ['Minor','Major'][avg('mode')>0?1:0] };
 } catch (err) { console.error('Artist stats error:', err.message); return null; }
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
   if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
   return { error: err.message };
 }
}

// ─── BLOCK KIT HELPERS ───────────────────────────────────
const divider = () => ({ type: 'divider' });
const header = t => ({ type: 'header', text: { type: 'plain_text', text: t, emoji: true } });
const section = t => ({ type: 'section', text: { type: 'mrkdwn', text: t } });
const twoCol = (l, r) => ({ type: 'section', fields: [{ type: 'mrkdwn', text: l }, { type: 'mrkdwn', text: r }] });
const context = t => ({ type: 'context', elements: [{ type: 'mrkdwn', text: t }] });
const btn = (text, actionId, style) => {
 const b = { type: 'button', text: { type: 'plain_text', text, emoji: true }, action_id: actionId };
 if (style) b.style = style;
 return b;
};
const actions = btns => ({ type: 'actions', elements: btns });

// ─── SESSIONS ────────────────────────────────────────────
global.compareSessions = global.compareSessions || {};
const getCompareSession = id => global.compareSessions[id] || null;
const startCompareSession = id => { global.compareSessions[id] = { status: 'waiting_your_track', yourTrack: null, referenceTrack: null, startedAt: new Date().toISOString() }; return global.compareSessions[id]; };
const clearCompareSession = id => { delete global.compareSessions[id]; };

global.collabSessions = global.collabSessions || {};
const getCollabSession = id => global.collabSessions[id] || null;
const startCollabSession = (channelId, trackName, userId) => { global.collabSessions[channelId] = { trackName, startedBy: userId, startedAt: new Date().toISOString(), ideas: [], feedback: [], decisions: [] }; return global.collabSessions[channelId]; };
const endCollabSession = id => { const s = global.collabSessions[id]; delete global.collabSessions[id]; return s; };

// ─── SAMPLES BUILDER ─────────────────────────────────────
async function buildSamplesResponse(query, userId) {
 const sounds = await searchFreesound(query, userId);
 if (!sounds || !sounds.length) {
   const simple = query.split(' ')[0];
   const retry = simple !== query ? await searchFreesound(simple, userId) : null;
   if (retry?.length) {
     const blocks = [header(`🎵 Samples for "${simple}"`), section(`_No exact results for "${query}" — showing "${simple}" · Search again for different results_`), divider()];
     retry.slice(0, 8).forEach((s, i) => {
       blocks.push(section(`*${i+1}. ${s.name}*\n⏱️ *${s.duration}s* · ⭐ *${s.rating}/5* · 📥 *${s.downloads.toLocaleString()}*\n📄 ${s.license} · 👤 ${s.username}\n🏷️ ${s.tags}\n\n${s.preview ? `🔊 *<${s.preview}|▶ Listen>*     ` : ''}🔗 *<${s.url}|📥 Download>*`));
       if (i < retry.slice(0,8).length - 1) blocks.push(divider());
     });
     blocks.push(divider(), context('Search again for different sounds · Freesound.org'));
     return blocks;
   }
   return [header('❗ No Results'), section(`No sounds for *"${query}"*.\n\nTry: piano · drums · bass · guitar · synth`), section(`🔗 *<https://freesound.org/search/?q=${encodeURIComponent(query)}|Browse Freesound>*`)];
 }
 const aiTip = await askAI(`Producer looking for "${query}" samples. 2-3 quick production tips. Under 50 words. Bullets.`);
 const blocks = [header(`🎵 Free Samples: "${query}"`), section(`*${sounds.length} sounds* — all free · _Search again for different results_`), context('🔊 Click Listen to preview · 📥 Click Download for file'), divider()];
 sounds.forEach((s, i) => {
   blocks.push(section(`*${i+1}. ${s.name}*\n⏱️ *${s.duration}s* · ⭐ *${s.rating}/5* · 📥 *${s.downloads.toLocaleString()}*\n📄 ${s.license} · 👤 ${s.username}\n🏷️ ${s.tags}\n\n${s.preview ? `🔊 *<${s.preview}|▶ Listen>*     ` : ''}🔗 *<${s.url}|📥 Download>*`));
   if (i < sounds.length - 1) blocks.push(divider());
 });
 if (aiTip) blocks.push(divider(), header(`💡 Tips for ${query} samples`), section(aiTip));
 blocks.push(divider(), section(`🔗 *<https://freesound.org/search/?q=${encodeURIComponent(query)}|Browse more on Freesound>*`), context('Creative Commons · Search again for different sounds'));
 return blocks;
}

// ─── PROJECT BLOCKS ──────────────────────────────────────
function buildProjectBlocks(project) {
 const health = getProjectHealth(project);
 const blocks = [
   header(`📋 ${project.name}`),
   section(`*Progress:* ${scoreBar(health.percent)}\n*Sessions:* ${health.done}/${health.total} complete`),
   divider(),
 ];
 for (const [key, session] of Object.entries(project.sessions)) {
   const days = daysUntil(session.deadline);
   const emoji = deadlineEmoji(days);
   const status = session.done ? '✅' : '☐';
   const deadlineText = session.deadline
     ? `${emoji} ${days < 0 ? `${Math.abs(days)} days overdue` : days === 0 ? 'Due today' : `${days} days left`} · ${new Date(session.deadline).toLocaleDateString()}`
     : '_No deadline set_';
   blocks.push(section(`${status} *${sessionLabel(key)}*\n${deadlineText}`));
 }
 blocks.push(divider(), context('Type /wavmind project deadline [session] [date] to set deadlines · /wavmind project done [session] to mark complete'));
 return blocks;
}

// ─── WELCOME BLOCKS ───────────────────────────────────────
function getWelcomeBlocks() {
 return [
   header('🎛️ Hey! I\'m Wavmind 👋'),
   section('I\'m your autonomous AI music production agent.\n\n*Just DM me naturally — no commands needed:*\n• "find me some trap drums"\n• "my mix feels muddy"\n• "how do I sidechain in fl studio"\n• "give me chord ideas in F minor"\n• "show me my project"'),
   divider(),
   actions([
     btn('🎵 Analyze My Music', 'menu_analyze', 'primary'),
     btn('🎹 Make Music', 'menu_create'),
   ]),
   actions([
     btn('🎚️ Get Feedback', 'menu_feedback'),
     btn('📋 My Projects', 'menu_projects'),
   ]),
   divider(),
   section('*Commands:*\n\n/wavmind project new [name] — Start a project\n/wavmind project — View active project\n/wavmind compare — Compare tracks\n/wavmind samples piano — Free samples\n/wavmind feedback [describe] — Mix advice\n/wavmind daw fl studio [question] — DAW help\n/wavmind reference [song - artist] — Analyze song\n/wavmind label [describe] — A&R evaluation\n/wavmind artist [a] and [b] — Compare artists'),
   divider(),
   context('💡 DM me and talk naturally — I understand plain English'),
 ];
}

// ─── MENU BLOCKS ─────────────────────────────────────────
function getAnalyzeBlocks() {
 return [
   header('🔬 Analyze Your Music'),
   divider(),
   section('*🆚 Compare Your Track vs Reference*\nType: /wavmind compare'),
   section('*🔍 Analyze Any Song from Spotify*\nType: /wavmind reference Tum Hi Ho - Arijit Singh\nType: /wavmind reference Blinding Lights - The Weeknd\n\n_Works with any case — uppercase or lowercase_'),
   section('*🎛️ Quick Audio Scan*\nJust upload any MP3 or WAV file'),
   divider(),
   actions([btn('← Back', 'menu_main')]),
 ];
}

function getCreateBlocks() {
 return [
   header('🎹 Make Music'),
   divider(),
   section('*🎵 Free Samples — different results every search*\nType: /wavmind samples drums\nType: /wavmind samples piano\nType: /wavmind samples bass\nType: /wavmind samples guitar\nType: /wavmind samples synth\nType: /wavmind samples strings'),
   section('*💡 Track Ideas*\nType: /wavmind ideas dark trap\nType: /wavmind ideas lo-fi chill'),
   section('*🎹 Chord Progressions*\nType: /wavmind chords F minor trap'),
   section('*🎹 DAW Help*\nType: /wavmind daw fl studio sidechain 808\nType: /wavmind daw ableton warp audio\nType: /wavmind daw logic pro flex pitch'),
   divider(),
   actions([btn('← Back', 'menu_main')]),
 ];
}

function getFeedbackBlocks() {
 return [
   header('🎚️ Get Feedback'),
   divider(),
   section('*🎚️ Mix Feedback*\nType: /wavmind feedback my trap beat at 140bpm feels muddy'),
   section('*🎛️ Deep Analysis (after uploading audio)*\nType: /wavmind feedback bpm:140 key:F_minor'),
   section('*🎯 A&R / Label Evaluation*\nGet an honest label executive assessment of your track\n\nType: /wavmind label dark trap 140bpm heavy 808s melodic hook'),
   section('*🎤 Artist Comparison*\nType: /wavmind artist Drake and Travis Scott'),
   divider(),
   actions([btn('← Back', 'menu_main')]),
 ];
}

function getProjectsBlocks(userId) {
 const projects = getProjects(userId);
 const active = projects.filter(p => !p.completed);
 const completed = projects.filter(p => p.completed);
 const blocks = [header('📋 My Projects'), divider()];
 if (active.length === 0) {
   blocks.push(section('No active projects.\n\nStart one:\nType: /wavmind project new My EP Track 1'));
 } else {
   for (const project of active) {
     const health = getProjectHealth(project);
     blocks.push(section(`*${project.name}*\n${scoreBar(health.percent)}\n${health.done}/${health.total} sessions complete`));
   }
 }
 if (completed.length > 0) blocks.push(divider(), section(`✅ *${completed.length} completed project${completed.length !== 1 ? 's' : ''}*`));
 blocks.push(divider(), section('Type: /wavmind project new [name]\nType: /wavmind project\nType: /wavmind project deadline recording 2026-06-15\nType: /wavmind project done recording\nType: /wavmind project complete'), actions([btn('← Back', 'menu_main')]));
 return blocks;
}

// ─── BUTTON HANDLERS ─────────────────────────────────────
app.action('menu_main', async ({ body, ack, client }) => { await ack(); await client.chat.postMessage({ channel: body.user.id, blocks: getWelcomeBlocks() }); });
app.action('menu_analyze', async ({ body, ack, client }) => { await ack(); await client.chat.postMessage({ channel: body.user.id, blocks: getAnalyzeBlocks() }); });
app.action('menu_create', async ({ body, ack, client }) => { await ack(); await client.chat.postMessage({ channel: body.user.id, blocks: getCreateBlocks() }); });
app.action('menu_feedback', async ({ body, ack, client }) => { await ack(); await client.chat.postMessage({ channel: body.user.id, blocks: getFeedbackBlocks() }); });
app.action('menu_projects', async ({ body, ack, client }) => { await ack(); await client.chat.postMessage({ channel: body.user.id, blocks: getProjectsBlocks(body.user.id) }); });
app.action('quick_compare', async ({ body, ack, client }) => {
 await ack();
 startCompareSession(body.user.id);
 await client.chat.postMessage({ channel: body.user.id, blocks: [header('🆚 Comparison Started!'), section('Step 1 — Upload YOUR track\nStep 2 — Upload your REFERENCE track\n\nWavmind compares both automatically.'), context('To cancel type /wavmind cancel')] });
});
app.action('quick_feedback', async ({ body, ack, client }) => {
 await ack();
 await client.chat.postMessage({ channel: body.user.id, blocks: [header('🎚️ Mix Feedback'), section('Describe your mix:\n\nType: /wavmind feedback my trap beat at 140bpm feels muddy')] });
});

// ─── APP HOME ─────────────────────────────────────────────
async function publishAppHome(client, userId) {
 const uploads = global.userUploads[userId] || [];
 const lastUpload = uploads[uploads.length - 1];
 const stats = global.weeklyStats[userId];
 const activeProject = getActiveProject(userId);
 const blocks = [section('*🎛️ Wavmind*\n_Your autonomous AI music production agent_'), divider()];

 if (activeProject) {
   const health = getProjectHealth(activeProject);
   blocks.push(header('📋 Active Project'));
   blocks.push(section(`*${activeProject.name}*\n${scoreBar(health.percent)}`));
   for (const [key, session] of Object.entries(activeProject.sessions)) {
     const days = daysUntil(session.deadline);
     const emoji = deadlineEmoji(days);
     const status = session.done ? '✅' : '☐';
     const deadlineText = session.deadline ? `${emoji} ${days < 0 ? 'overdue' : days === 0 ? 'today' : `${days}d`}` : '';
     blocks.push(twoCol(`${status} *${sessionLabel(key)}*`, deadlineText));
   }
   blocks.push(actions([btn('📋 View Full Project', 'menu_projects'), btn('🆚 Compare Tracks', 'quick_compare')]), divider());
 }

 if (lastUpload) {
   blocks.push(
     header('📊 Your Last Track'),
     twoCol(`🎵 *File*\n${lastUpload.filename}`, `⚡ *Energy*\n${scoreBar(lastUpload.analysis.energy)}`),
     twoCol(`🔊 *Bass*\n${lastUpload.analysis.bass_ratio}%`, `🌈 *Brightness*\n${lastUpload.analysis.brightness}`),
     context(`_Scanned ${new Date(lastUpload.timestamp).toLocaleDateString()} · Reminder DM in 24hrs_`),
     actions([btn('🆚 Compare with Reference', 'quick_compare', 'primary'), btn('🎚️ Get Feedback', 'quick_feedback')]),
     divider()
   );
 }

 if (stats && stats.tracks > 0) {
   blocks.push(header('📈 This Week'), twoCol(`🎵 *Tracks Scanned*\n${stats.tracks}`, `⚠️ *Top Issue*\n${stats.issues[0] || 'None'}`), divider());
 }

 blocks.push(
   header('💬 Talk to Me Directly'),
   section('DM me or @mention me — no commands needed:\n\n• "find me some trap drums"\n• "my mix feels muddy"\n• "how do I sidechain in fl studio"\n• "chord ideas for F minor trap"\n• "show me my project"'),
   divider(),
   header('🎛️ Commands'),
   twoCol('*📋 Projects*\n/wavmind project new [name]\n/wavmind project', '*🆚 Compare*\n/wavmind compare'),
   twoCol('*🎵 Samples*\n/wavmind samples piano\n/wavmind samples drums', '*🎹 DAW Help*\n/wavmind daw fl studio [q]'),
   twoCol('*🎚️ Mix Feedback*\n/wavmind feedback [describe]', '*🔍 Analyze Song*\n/wavmind reference [song]'),
   twoCol('*🎯 Label Eval*\n/wavmind label [describe]', '*🎤 Artists*\n/wavmind artist [a] and [b]'),
   divider(),
   header('🤖 Autonomous Features'),
   section('• *Project reminders* — DM when sessions are due (7d, 3d, 1d, day-of)\n• *24hr track reminder* — follow-up after uploads\n• *Weekly report* — every Monday 9am\n• *Channel monitor* — jumps into music conversations\n• *MCP Server* — AI agents can connect to Wavmind tools'),
   divider(),
   header('⚡ Powered By'),
   twoCol('🤖 *Groq AI* — Llama 3.1', '🎵 *Spotify* — Real audio data'),
   twoCol('🔍 *Tavily* — Real-time search', '🎵 *Freesound* — 500K+ samples'),
   twoCol('🎧 *Librosa* — Audio analysis', '🔌 *MCP* — AI agent protocol'),
   divider(),
   context('🎛️ *Wavmind* — Just DM me and talk naturally')
 );

 await client.views.publish({ user_id: userId, view: { type: 'home', blocks } });
}

app.event('app_home_opened', async ({ event, client }) => {
 try { await publishAppHome(client, event.user); } catch (err) { console.error('Home error:', err.message); }
});

// ─── CHANNEL MONITORING + DM HANDLER ─────────────────────
app.message(async ({ message, say, client }) => {
 if (message.subtype || !message.text) return;
 const lower = message.text.toLowerCase().trim();
 const userId = message.user;

 if (message.channel_type === 'im') {
   if (['hi','hello','hey','start','help','menu'].includes(lower)) {
     await say({ blocks: getWelcomeBlocks() });
     return;
   }

   const intent = await conversationalAI(message.text);

   if (intent.type === 'project') {
     const project = getActiveProject(userId);
     if (!project) {
       await say({ blocks: [header('📋 Project Management'), section('You have no active project.\n\nTo start one:\nType: /wavmind project new My EP Track 1')] });
     } else {
       await say({ blocks: buildProjectBlocks(project) });
     }
     return;
   }

   if (intent.type === 'compare') {
     startCompareSession(userId);
     await say({ blocks: [header('🆚 Comparison Mode Started'), section('Upload your track first, then your reference track.\nWavmind will compare both automatically.'), context('To cancel type /wavmind cancel')] });
     return;
   }

   if (intent.type === 'samples') {
     await say({ blocks: [section(`🔍 Finding *${intent.query}* samples...`), context('⏳')] });
     const blocks = await buildSamplesResponse(intent.query, userId);
     await say({ blocks });
     return;
   }

   if (intent.type === 'feedback') {
     await say({ blocks: [section('🎚️ Analyzing...'), context('⏳')] });
     const r = await askAI(`Professional mixing feedback for: "${message.text}". EQ, compression, stereo width, frequency balance. Clear sections with emojis.`);
     await say({ blocks: [header('🎚️ Mix Feedback'), section(r || 'Error'), divider(), context('Upload MP3/WAV then type /wavmind feedback bpm:140 key:F_minor for deeper analysis')] });
     return;
   }

   if (intent.type === 'daw') {
     await say({ blocks: [section('🎹 Searching for DAW help...'), context('⏳')] });
     const [tav, ai] = await Promise.all([tavilySearch(`${message.text} tutorial step by step`), askAI(`Expert DAW instructor. Answer: "${message.text}". Numbered steps. Bold key terms.`)]);
     const blocks = [header('🎹 DAW Help'), divider(), section('🤖 *AI Answer:*'), section(ai || 'Error')];
     if (tav?.answer) blocks.push(divider(), section('🌐 *From the Web:*'), section(tav.answer));
     if (tav?.results?.length) blocks.push(divider(), section('📚 *Resources:*'), section(tav.results.slice(0,3).map(r=>`• <${r.url}|${r.title}>`).join('\n')));
     await say({ blocks });
     return;
   }

   if (intent.type === 'chords') {
     const r = await askAI(`Music theory expert. Chord question: "${message.text}". Chord names, Roman numerals, emotional feel.`);
     await say({ blocks: [header('🎹 Chord Help'), section(r || 'Error')] });
     return;
   }

   if (intent.type === 'bpm') {
     const r = await askAI(`Music production expert. BPM/tempo/key question: "${message.text}". Be specific with numbers.`);
     await say({ blocks: [header('🥁 BPM & Key'), section(r || 'Error')] });
     return;
   }

   if (intent.type === 'ideas') {
     const r = await askAI(`Creative music producer. Answer: "${message.text}". 3-5 track ideas with BPM, key, concept.`);
     await say({ blocks: [header('🎵 Track Ideas'), section(r || 'Error')] });
     return;
   }

   if (intent.type === 'label') {
     const bpmMatch = message.text.match(/(\d+)\s*(bpm|tempo)?/i);
     const bpmContext = bpmMatch ? `Note: ${bpmMatch[1]} BPM is ${parseInt(bpmMatch[1]) < 70 ? 'very slow/ambient' : parseInt(bpmMatch[1]) < 90 ? 'slow/relaxed' : parseInt(bpmMatch[1]) < 110 ? 'mid-tempo' : parseInt(bpmMatch[1]) < 130 ? 'moderate' : parseInt(bpmMatch[1]) < 150 ? 'fast/energetic' : 'very fast/aggressive'} for music production context.` : '';
     const r = await askAI(`Senior A&R executive evaluation for: "${message.text}". ${bpmContext} Commercial Potential (1-10), Playlist Potential, Target Audience, Strengths, Weaknesses, Verdict. Be honest and specific.`);
     await say({ blocks: [header('🎯 Label Evaluation'), section(r || 'Error')] });
     return;
   }

   const r = await askAI(`You are Wavmind, expert AI for music producers. The producer said: "${message.text}". Give a helpful, specific, professional response.`);
   await say({ blocks: [section(r || 'Could not respond. Try again!'), context('Type help or tap a menu button')] });
   return;
 }

 // Channel monitoring
 const keywords = ['muddy','808','sidechain','compress','reverb','mixing','mastering','plugin','vst','fl studio','ableton','logic pro','melody','chord','bass line','hi-hat','kick','snare','bpm'];
 const hasKeyword = keywords.some(kw => lower.includes(kw));
 if (hasKeyword && !lower.startsWith('/') && Math.random() < 0.33) {
   try {
     const r = await askAI(`Music producer said: "${message.text}". 2-sentence tip. End with one suggestion. Be conversational.`);
     if (r) await say({ thread_ts: message.ts, blocks: [section(`🎛️ *Wavmind:* ${r}`), context('DM me to chat · Type /wavmind for commands')] });
   } catch (err) { console.error('Monitor error:', err.message); }
 }
});

// ─── APP MENTION ──────────────────────────────────────────
app.event('app_mention', async ({ event, say }) => {
 const input = event.text.replace(/<@[^>]+>/g, '').trim();
 if (!input) { await say({ blocks: getWelcomeBlocks() }); return; }
 const intent = await conversationalAI(input);
 if (intent.type === 'samples') { const blocks = await buildSamplesResponse(intent.query, event.user); await say({ blocks }); return; }
 if (intent.type === 'feedback') { const r = await askAI(`Mixing feedback: "${input}".`); await say({ blocks: [section(`<@${event.user}>`), header('🎚️ Mix Feedback'), section(r||'Error')] }); return; }
 if (intent.type === 'daw') { const [tav,ai] = await Promise.all([tavilySearch(`${input} tutorial`), askAI(`DAW instructor. Answer: "${input}". Numbered steps.`)]); const blocks = [section(`<@${event.user}>`), header('🎹 DAW Help'), section(ai||'Error')]; if (tav?.answer) blocks.push(divider(), section(tav.answer)); await say({ blocks }); return; }
 const r = await askAI(`You are Wavmind, expert AI for music producers. Answer: "${input}"`);
 await say({ blocks: [section(`<@${event.user}>`), section(r||'Error'), context('DM me to chat · Type /wavmind for features')] });
});

// ─── FILE UPLOAD ─────────────────────────────────────────
app.event('file_shared', async ({ event, client }) => {
 try {
   const fileInfo = await client.files.info({ file: event.file_id });
   const file = fileInfo.file;
   const ext = file.name.split('.').pop().toLowerCase();
   if (!['mp3','wav','flac','aac','m4a','ogg'].includes(ext)) return;

   const userId = event.user_id;
   const channelId = event.channel_id;
   const compareSession = userId ? getCompareSession(userId) : null;

   if (compareSession) {
     if (compareSession.status === 'waiting_your_track') {
       await client.chat.postMessage({ channel: channelId, blocks: [header('🎵 Scanning Your Track...'), section(`*File:* ${file.name}`), context('⏳ Step 1 of 2')] });
       const analysis = await analyzeAudioFile(file.url_private_download, file.name);
       if (!analysis || analysis.error) { await client.chat.postMessage({ channel: channelId, blocks: [header('❗ Scan Failed'), section('Try MP3 under 10MB.')] }); return; }
       compareSession.yourTrack = { filename: file.name, energy: analysis.energy, brightness: analysis.brightness, bass_ratio: analysis.bass_ratio, duration: analysis.duration };
       compareSession.status = 'waiting_reference';
       const mins = Math.floor(analysis.duration / 60); const secs = String(analysis.duration % 60).padStart(2, '0');
       await client.chat.postMessage({
         channel: channelId,
         blocks: [
           header('✅ Your Track Scanned — Step 1 of 2'),
           section(`*File:* ${file.name}`),
           divider(),
           twoCol(`⚡ *Energy*\n${scoreBar(analysis.energy)}`, `🌈 *Brightness*\n${analysis.brightness}`),
           twoCol(`🔊 *Bass*\n${analysis.bass_ratio}%`, `⏱️ *Duration*\n${mins}:${secs}`),
           divider(),
           header('🎯 Step 2 — Upload Your Reference Track'),
           section('Upload the song you want to sound like.'),
           context('Wavmind compares both automatically'),
         ],
       });
     } else if (compareSession.status === 'waiting_reference') {
       await client.chat.postMessage({ channel: channelId, blocks: [header('🔍 Scanning Reference...'), section(`*File:* ${file.name}`), context('⏳ Generating report...')] });
       const analysis = await analyzeAudioFile(file.url_private_download, file.name);
       if (!analysis || analysis.error) { await client.chat.postMessage({ channel: channelId, blocks: [header('❗ Scan Failed'), section('Try MP3 under 10MB.')] }); return; }
       compareSession.referenceTrack = { filename: file.name, energy: analysis.energy, brightness: analysis.brightness, bass_ratio: analysis.bass_ratio, duration: analysis.duration };
       const yours = compareSession.yourTrack; const ref = compareSession.referenceTrack;
       const energyDiff = ref.energy - yours.energy; const bassDiff = ref.bass_ratio - yours.bass_ratio;
       const bMap = { 'Dark (heavy low end)': 1, 'Balanced': 2, 'Bright (strong high end)': 3 };
       const brightDiff = (bMap[ref.brightness] || 2) - (bMap[yours.brightness] || 2);
       const yourMins = Math.floor(yours.duration / 60); const yourSecs = String(yours.duration % 60).padStart(2, '0');
       const refMins = Math.floor(ref.duration / 60); const refSecs = String(ref.duration % 60).padStart(2, '0');
       const energyStatus = Math.abs(energyDiff) <= 5 ? '✅ Match' : energyDiff > 0 ? '🔴 Ref higher — add compression/limiting' : '🟢 Yours higher';
       const bassStatus = Math.abs(bassDiff) <= 5 ? '✅ Match' : bassDiff > 0 ? '🔴 Ref heavier — boost low end' : '🟢 Yours heavier';
       const brightStatus = brightDiff === 0 ? '✅ Match' : brightDiff > 0 ? '🟡 Ref brighter — boost highs' : '🟡 Yours brighter';
       const aiAnalysis = await askAI(`Professional mixing engineer:
YOUR TRACK "${yours.filename}": Energy ${yours.energy}%, Brightness ${yours.brightness}, Bass ${yours.bass_ratio}%
REFERENCE "${ref.filename}": Energy ${ref.energy}%, Brightness ${ref.brightness}, Bass ${ref.bass_ratio}%
Energy gap: ${Math.abs(energyDiff)}% ${energyDiff > 0 ? '(ref higher)' : '(yours higher)'}
Bass gap: ${Math.abs(bassDiff)}% ${bassDiff > 0 ? '(ref heavier)' : '(yours heavier)'}
Brightness: ${brightDiff > 0 ? 'Ref brighter' : brightDiff < 0 ? 'Yours brighter' : 'Matched'}
Specific EQ, compression, bass advice. Top 3 changes. Real plugin names.`);
       clearCompareSession(userId);
       await client.chat.postMessage({
         channel: channelId,
         blocks: [
           header('🆚 Mix Comparison Report'),
           divider(),
           twoCol(`🎵 *Your Track*\n${yours.filename}`, `🎯 *Reference*\n${ref.filename}`),
           divider(),
           section('📊 *Gap Analysis*'),
           section(`⚡ *Energy:* ${scoreBar(yours.energy)} → ${ref.energy}%\n${energyStatus}`),
           section(`🔊 *Bass:* ${yours.bass_ratio}% → ${ref.bass_ratio}%\n${bassStatus}`),
           section(`🌈 *Brightness:* ${yours.brightness} → ${ref.brightness}\n${brightStatus}`),
           twoCol(`⏱️ *Your Duration*\n${yourMins}:${yourSecs}`, `⏱️ *Ref Duration*\n${refMins}:${refSecs}`),
           divider(),
           header('🤖 How to Close the Gap'),
           section(aiAnalysis || 'Could not generate.'),
           divider(),
           section('Apply changes, re-export, then type /wavmind compare again'),
           actions([btn('🆚 Compare Again', 'quick_compare', 'primary'), btn('🎚️ Get More Feedback', 'quick_feedback')]),
         ],
       });
     }
     return;
   }

   await client.chat.postMessage({ channel: channelId, blocks: [header('🎵 Scanning Your Track...'), section(`*File:* ${file.name}`), context('⏳ Analyzing...')] });
   const analysis = await analyzeAudioFile(file.url_private_download, file.name);
   if (!analysis || analysis.error) { await client.chat.postMessage({ channel: channelId, blocks: [header('❗ Scan Failed'), section('Try MP3 under 10MB.')] }); return; }

   if (userId) trackUpload(userId, file.name, analysis);
   global.pendingAnalysis = global.pendingAnalysis || {};
   global.pendingAnalysis[channelId] = { filename: file.name, energy: analysis.energy, brightness: analysis.brightness, bass_ratio: analysis.bass_ratio, duration: analysis.duration };

   const mins = Math.floor(analysis.duration / 60); const secs = String(analysis.duration % 60).padStart(2, '0');
   const issues = [];
   if (analysis.energy < 50) issues.push('⚠️ Low energy — mix may lack punch');
   if (analysis.bass_ratio > 65) issues.push('⚠️ Heavy bass — may sound muddy on small speakers');
   if (analysis.bass_ratio < 20) issues.push('⚠️ Thin bass — needs more low end');

   await client.chat.postMessage({
     channel: channelId,
     blocks: [
       header('🎛️ Scan Complete'),
       section(`*File:* ${file.name}`),
       divider(),
       twoCol(`⚡ *Energy*\n${scoreBar(analysis.energy)}`, `🌈 *Brightness*\n${analysis.brightness}`),
       twoCol(`🔊 *Bass*\n${analysis.bass_ratio}%`, `⏱️ *Duration*\n${mins}:${secs}`),
       ...(issues.length > 0 ? [divider(), section(`*Quick Insights:*\n${issues.join('\n')}`)] : []),
       divider(),
       section('*What do you want to do next?*'),
       actions([btn('🆚 Compare with Reference', 'quick_compare', 'primary'), btn('🎚️ Get Mix Feedback', 'quick_feedback')]),
       context('🤖 Wavmind will DM you tomorrow with a follow-up reminder'),
     ],
   });

   if (userId) { try { await publishAppHome(client, userId); } catch (e) {} }
 } catch (err) { console.error('File error:', err.message); }
});

// ─── SCHEDULER ────────────────────────────────────────────
function startScheduler(client) {

 const checkReminders = async () => {
   try {
     const now = new Date(); let changed = false;
     for (const userId of Object.keys(global.pendingReminders)) {
       for (const reminder of global.pendingReminders[userId]) {
         if (reminder.sent || new Date(reminder.remindAt) > now) continue;
         reminder.sent = true; changed = true;
         const issues = [];
         if (reminder.analysis.energy < 50) issues.push('☐ Low energy — needs more punch');
         if (reminder.analysis.bass_ratio > 65) issues.push('☐ Heavy bass — check on small speakers');
         if (reminder.analysis.bass_ratio < 20) issues.push('☐ Thin bass — add more low end');
         console.log(`📬 Reminder → ${userId} for "${reminder.filename}"`);
         await client.chat.postMessage({
           channel: userId,
           blocks: [
             header('🎛️ Wavmind Check-in'),
             section(`Hey! You uploaded *"${reminder.filename}"* yesterday.\n\nHave you fixed these issues?`),
             divider(),
             ...(issues.length > 0 ? [section(`*Pending:*\n${issues.join('\n')}`)] : [section('✅ Your track looked clean. Ready to release?')]),
             divider(),
             actions([btn('🆚 Compare with Reference', 'quick_compare', 'primary'), btn('🎚️ Fresh Feedback', 'quick_feedback')]),
             context('🤖 Autonomous check-in from Wavmind'),
           ],
         });
         try { await publishAppHome(client, userId); } catch (e) {}
       }
     }
     if (changed) saveFile(REMINDERS_FILE, global.pendingReminders, 'reminders');
   } catch (err) { console.error('Reminder error:', err.message); }
 };

 const checkProjectDeadlines = async () => {
   try {
     const now = new Date();
     for (const userId of Object.keys(global.userProjects)) {
       for (const project of global.userProjects[userId] || []) {
         if (project.completed) continue;
         for (const [sessionType, session] of Object.entries(project.sessions)) {
           if (session.done || !session.deadline) continue;
           const days = daysUntil(session.deadline);
           if (days === null) continue;

           let shouldNotify = false; let urgency = '';
           if (days < 0 && !session.notifiedOverdue) { shouldNotify = true; urgency = '🔴 *OVERDUE*'; session.notifiedOverdue = true; }
           else if (days === 0 && !session.notifiedDay0) { shouldNotify = true; urgency = '🔴 *DUE TODAY*'; session.notifiedDay0 = true; }
           else if (days === 1 && !session.notifiedDay1) { shouldNotify = true; urgency = '🟡 *Due tomorrow*'; session.notifiedDay1 = true; }
           else if (days === 3 && !session.notifiedDay3) { shouldNotify = true; urgency = '🟡 *Due in 3 days*'; session.notifiedDay3 = true; }
           else if (days === 7 && !session.notifiedDay7) { shouldNotify = true; urgency = '🟢 *Due in 7 days*'; session.notifiedDay7 = true; }

           if (!shouldNotify) continue;

           const health = getProjectHealth(project);
           const aiTip = await askAI(`Music producer needs to complete "${sessionLabel(sessionType)}" for project "${project.name}" ${days < 0 ? 'which is overdue' : `in ${days} day${days !== 1 ? 's' : ''}`}. One specific actionable tip to finish quickly. Under 40 words.`);

           console.log(`📅 Deadline notification → ${userId} "${project.name}" ${sessionType}`);
           await client.chat.postMessage({
             channel: userId,
             blocks: [
               header(`📋 Project Reminder: ${project.name}`),
               section(`${urgency} — ${sessionLabel(sessionType)} session`),
               divider(),
               section(`*Project Progress:*\n${scoreBar(health.percent)}`),
               divider(),
               section(`*🤖 Quick tip:*\n${aiTip || 'Focus and get it done!'}`),
               divider(),
               section(`Mark complete when done:\nType: /wavmind project done ${sessionType}`),
               context('🤖 Autonomous project reminder from Wavmind'),
             ],
           });
           saveFile(PROJECTS_FILE, global.userProjects, 'projects');
         }
       }
     }
   } catch (err) { console.error('Project deadline error:', err.message); }
 };

 const sendDigest = async () => {
   try {
     for (const userId of Object.keys(global.weeklyStats)) {
       const stats = global.weeklyStats[userId];
       if (!stats || stats.tracks === 0) continue;
       const topIssue = stats.issues.sort((a,b) => stats.issues.filter(i=>i===b).length - stats.issues.filter(i=>i===a).length)[0] || 'None';
       const tip = await askAI(`Producer analyzed ${stats.tracks} tracks. Issue: ${topIssue}. One specific tip. Under 50 words.`);
       const projects = getProjects(userId);
       await client.chat.postMessage({
         channel: userId,
         blocks: [
           header('📊 Your Weekly Report'),
           section(`*Week of ${new Date().toLocaleDateString()}*`),
           divider(),
           twoCol(`🎵 *Tracks Scanned*\n${stats.tracks}`, `⚠️ *Top Issue*\n${topIssue}`),
           twoCol(`📋 *Active Projects*\n${projects.filter(p=>!p.completed).length}`, `✅ *Completed*\n${projects.filter(p=>p.completed).length}`),
           divider(),
           section(`*🤖 This week's tip:*\n${tip || 'Keep producing!'}`),
           divider(),
           section('Try this week:\n/wavmind compare — Check your mix\n/wavmind samples — Find new sounds\n/wavmind project — View your projects'),
           context('📊 Automated weekly report · Every Monday 9am · Wavmind'),
         ],
       });
       global.weeklyStats[userId] = { tracks: 0, issues: [] };
       saveFile(STATS_FILE, global.weeklyStats, 'stats');
     }
   } catch (err) { console.error('Digest error:', err.message); }
 };

 checkReminders();
 setInterval(checkReminders, 5 * 60 * 1000);

 checkProjectDeadlines();
 setInterval(checkProjectDeadlines, 60 * 60 * 1000);

 const now = new Date();
 const nextMonday = new Date();
 nextMonday.setDate(now.getDate() + ((1 + 7 - now.getDay()) % 7 || 7));
 nextMonday.setHours(9, 0, 0, 0);
 setTimeout(() => { sendDigest(); setInterval(sendDigest, 7 * 24 * 60 * 60 * 1000); }, nextMonday - now);

 console.log('⏰ Scheduler started — reminders every 5min, deadlines every 1hr, digest every Monday 9am');
}

// ─── MCP SERVER ───────────────────────────────────────────
function startMCPServer() {
 const mcpTools = [
   { name: 'search_samples', description: 'Search 500K+ free Creative Commons samples from Freesound' },
   { name: 'get_track_features', description: 'Get real Spotify audio features for any track' },
   { name: 'analyze_mix', description: 'Get AI mixing feedback' },
   { name: 'get_daw_help', description: 'Get DAW tutorials via Tavily + AI' },
   { name: 'compare_artists', description: 'Compare two artists via Spotify data' },
   { name: 'get_track_ideas', description: 'Generate track concepts for any genre' },
 ];

 const server = http.createServer(async (req, res) => {
   res.setHeader('Content-Type', 'application/json');
   res.setHeader('Access-Control-Allow-Origin', '*');
   res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
   res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
   if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
   let body = '';
   req.on('data', c => body += c);
   req.on('end', async () => {
     try {
       if (req.url === '/health') { res.writeHead(200); res.end(JSON.stringify({ status: 'ok', service: 'Wavmind AI Producer Agent', version: '1.0.0', tools: mcpTools.map(t => t.name) })); return; }
       if (req.url === '/mcp') { res.writeHead(200); res.end(JSON.stringify({ name: 'wavmind', version: '1.0.0', description: 'AI tools for music producers', tools: mcpTools })); return; }
       if (req.url === '/mcp/tools') { res.writeHead(200); res.end(JSON.stringify({ tools: mcpTools })); return; }
       if (req.method === 'POST' && req.url === '/mcp/execute') {
         const { tool, arguments: args } = JSON.parse(body);
         let result;
         switch (tool) {
           case 'search_samples': result = await searchFreesound(args.query); break;
           case 'get_track_features': result = await getTrackFeatures(args.track_name); break;
           case 'analyze_mix': result = await askAI(`Mix feedback: ${args.description}. BPM: ${args.bpm||'?'}, Key: ${args.key||'?'}.`); break;
           case 'get_daw_help': { const [t,a] = await Promise.all([tavilySearch(`${args.daw} ${args.question}`), askAI(`${args.daw} tutorial: "${args.question}"`)]); result = { ai_answer: a, web_answer: t?.answer, sources: t?.results }; break; }
           case 'compare_artists': { const [s1,s2] = await Promise.all([getArtistStats(args.artist1), getArtistStats(args.artist2)]); result = { artist1: s1, artist2: s2 }; break; }
           case 'get_track_ideas': result = await askAI(`5 track ideas for "${args.genre}".`); break;
           default: result = { error: `Unknown tool: ${tool}` };
         }
         res.writeHead(200); res.end(JSON.stringify({ tool, result })); return;
       }
       res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
     } catch (err) { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); }
   });
 });

 const port = process.env.PORT || 8000;
 server.listen(port, () => console.log(`🔌 MCP Server on port ${port}`));
}

// ─── SLASH COMMANDS ───────────────────────────────────────
app.command('/wavmind', async ({ command, ack, respond, client }) => {
 await ack();
 const input = command.text.trim();
 const lower = input.toLowerCase();
 const userId = command.user_id;

 if (!input || lower === 'help' || lower === 'menu') {
   await respond({ response_type: 'ephemeral', blocks: getWelcomeBlocks() });
   return;
 }

 // ─── TEST COMMANDS (remove before submission) ─────────
 if (lower === 'test reminder') {
   const uploads = global.userUploads[userId] || [];
   const last = uploads[uploads.length - 1];
   if (!last) { await respond({ blocks: [header('❗ Upload a track first')] }); return; }
   if (!global.pendingReminders[userId]) global.pendingReminders[userId] = [];
   global.pendingReminders[userId].push({
     filename: last.filename, analysis: last.analysis,
     uploadedAt: new Date().toISOString(),
     remindAt: new Date(Date.now() + 10000).toISOString(),
     sent: false,
   });
   saveFile(REMINDERS_FILE, global.pendingReminders, 'reminders');
   await respond({ blocks: [header('⏰ Test Reminder Set'), section(`You will get a DM in 10 seconds for "${last.filename}"`)] });
   return;
 }

 if (lower === 'test digest') {
   if (!global.weeklyStats[userId]) global.weeklyStats[userId] = { tracks: 0, issues: [] };
   global.weeklyStats[userId].tracks = 5;
   global.weeklyStats[userId].issues = ['Heavy bass', 'Heavy bass', 'Low energy'];
   saveFile(STATS_FILE, global.weeklyStats, 'stats');
   await respond({ blocks: [header('✅ Test Data Set'), section('Weekly stats set to 5 tracks.\n\nWeekly digest fires every Monday 9am.')] });
   return;
 }

 // ─── PROJECT ─────────────────────────────────────────
 if (lower.startsWith('project')) {
   const sub = input.slice(7).trim();
   const subL = sub.toLowerCase();

   if (subL.startsWith('new')) {
     const name = sub.slice(3).trim() || 'My Project';
     const project = createProject(userId, name);
     await respond({
       blocks: [
         header('📋 Project Created'),
         section(`*${project.name}*\n${scoreBar(0)}`),
         divider(),
         section('*Set deadlines for each session:*\n\nType: /wavmind project deadline recording 2026-06-10\nType: /wavmind project deadline mixing 2026-06-15\nType: /wavmind project deadline mastering 2026-06-18\nType: /wavmind project deadline artwork 2026-06-20\nType: /wavmind project deadline release 2026-06-25'),
         divider(),
         section('*Sessions:*\n☐ 🎙️ Recording\n☐ 🎚️ Mixing\n☐ 🔊 Mastering\n☐ 🎨 Artwork\n☐ 🚀 Release'),
         context('🤖 Wavmind will send DM reminders at 7 days, 3 days, 1 day, and day-of each deadline'),
       ],
     });
     await publishAppHome(client, userId);
     return;
   }

   if (subL.startsWith('deadline')) {
     const parts = sub.slice(8).trim().split(' ');
     const sessionType = parts[0]?.toLowerCase();
     const dateStr = parts[1];
     const validSessions = ['recording', 'mixing', 'mastering', 'artwork', 'release'];
     if (!sessionType || !validSessions.includes(sessionType) || !dateStr) {
       await respond({ blocks: [header('❗ Missing info'), section('Type: /wavmind project deadline recording 2026-06-10\n\nSessions: recording · mixing · mastering · artwork · release')] });
       return;
     }
     const project = getActiveProject(userId);
     if (!project) { await respond({ blocks: [header('❗ No Active Project'), section('Type: /wavmind project new [name]')] }); return; }
     const parsed = new Date(dateStr);
     if (isNaN(parsed.getTime())) { await respond({ blocks: [header('❗ Invalid Date'), section('Use format: 2026-06-15')] }); return; }
     setSessionDeadline(userId, project.id, sessionType, parsed.toISOString().split('T')[0]);
     const days = daysUntil(parsed.toISOString());
     const emoji = deadlineEmoji(days);
     await respond({
       blocks: [
         header(`📅 Deadline Set — ${sessionLabel(sessionType)}`),
         section(`*Project:* ${project.name}\n*Session:* ${sessionLabel(sessionType)}\n*Deadline:* ${parsed.toLocaleDateString()} ${emoji} ${days} days away`),
         divider(),
         section('Wavmind will remind you:\n• 7 days before\n• 3 days before\n• 1 day before\n• On the day\n• If overdue'),
         context('🤖 Autonomous reminders now active'),
       ],
     });
     await publishAppHome(client, userId);
     return;
   }

   if (subL.startsWith('done')) {
     const sessionType = sub.slice(4).trim().toLowerCase();
     const validSessions = ['recording', 'mixing', 'mastering', 'artwork', 'release'];
     const project = getActiveProject(userId);
     if (!project) { await respond({ blocks: [header('❗ No Active Project'), section('Type: /wavmind project new [name]')] }); return; }
     if (!validSessions.includes(sessionType)) { await respond({ blocks: [header('❗ Invalid Session'), section('Sessions: recording · mixing · mastering · artwork · release')] }); return; }
     markSessionDone(userId, project.id, sessionType);
     const health = getProjectHealth(project);
     const allDone = health.done === health.total;
     await respond({
       blocks: [
         header(`✅ ${sessionLabel(sessionType)} Complete!`),
         section(`*${project.name}*\n${scoreBar(health.percent)}`),
         divider(),
         section(allDone ? '🎉 *All sessions complete!*\nType: /wavmind project complete' : `*${health.done}/${health.total} sessions done* · Keep going!`),
         context('Type /wavmind project to see all sessions'),
       ],
     });
     await publishAppHome(client, userId);
     return;
   }

   if (subL === 'complete') {
     const project = getActiveProject(userId);
     if (!project) { await respond({ blocks: [header('❗ No Active Project')] }); return; }
     completeProject(userId, project.id);
     await respond({
       blocks: [
         header('🎉 Project Complete!'),
         section(`*${project.name}* is done! Congratulations! 🚀`),
         divider(),
         section('Start a new project:\nType: /wavmind project new [name]'),
       ],
     });
     await publishAppHome(client, userId);
     return;
   }

   const project = getActiveProject(userId);
   if (!project) { await respond({ blocks: [header('📋 No Active Project'), section('Start one:\nType: /wavmind project new [name]')] }); return; }
   await respond({ blocks: buildProjectBlocks(project) });
   return;
 }

 // ─── COMPARE ─────────────────────────────────────────
 if (lower === 'compare' || lower === 'compare start') {
   if (getCompareSession(userId)) {
     const s = getCompareSession(userId);
     await respond({ blocks: [header('⚠️ Already Running'), section(`Status: ${s.status === 'waiting_your_track' ? 'Upload your track' : 'Upload reference'}\n\nTo cancel type /wavmind cancel`)] });
     return;
   }
   startCompareSession(userId);
   await respond({
     response_type: 'in_channel',
     blocks: [
       header('🆚 Mix Comparison Started'),
       section(`*<@${userId}>* follow these steps:`),
       divider(),
       section('Step 1 — Upload YOUR track (the beat you\'re working on)'),
       section('Step 2 — Upload your REFERENCE track (song you want to sound like)'),
       section('Step 3 — Wavmind compares both:\n• Energy, bass, brightness side by side\n• ✅ Match or ⚠️ Gap for each element\n• Specific AI advice to close each gap'),
       divider(),
       context('Upload now · To cancel type /wavmind cancel'),
     ],
   });
   return;
 }

 if (lower === 'cancel') { clearCompareSession(userId); await respond({ blocks: [header('🗑️ Cancelled'), section('To start again type /wavmind compare')] }); return; }

 // ─── SAMPLES ─────────────────────────────────────────
 if (lower.startsWith('samples') || lower.startsWith('sample')) {
   const query = input.replace(/^samples?\s*/i, '').trim();
   if (!query) {
     await respond({ blocks: [header('🎵 Free Sample Search'), section('Type: /wavmind samples drums\nType: /wavmind samples piano\nType: /wavmind samples bass\nType: /wavmind samples guitar\nType: /wavmind samples synth\nType: /wavmind samples strings\nType: /wavmind samples violin\nType: /wavmind samples flute\nType: /wavmind samples vocal\nType: /wavmind samples ambient\n\nSearch again for completely different results!'), context('500K+ Creative Commons sounds · Freesound.org')] });
     return;
   }
   await respond({ blocks: [header('🎵 Searching Freesound...'), section(`*"${query}"*`), context('⏳ Different results every search')] });
   const blocks = await buildSamplesResponse(query, userId);
   await respond({ blocks });
   return;
 }

 // ─── REFERENCE ───────────────────────────────────────
 if (lower.startsWith('reference')) {
   const q = input.slice(9).trim();
   if (!q) { await respond({ blocks: [header('🔍 Reference Track'), section('Type: /wavmind reference Tum Hi Ho - Arijit Singh\nType: /wavmind reference Blinding Lights - The Weeknd\n\n_Works with any case — uppercase or lowercase_')] }); return; }
   await respond({ blocks: [header('🔍 Looking Up on Spotify...'), section(`*${q}*`), context('⏳')] });
   const f = await getTrackFeatures(q);
   if (f) {
     const r = await askAI(`Advice on achieving sound of ${f.name} by ${f.artist}: BPM ${f.bpm}, Key ${f.key}, Energy ${f.energy}%, Loudness ${f.loudness}dB. Specific techniques and real plugin names.`);
     await respond({
       blocks: [
         header('🎵 Reference Analysis'),
         section(`*${f.name}* by *${f.artist}*`),
         divider(),
         twoCol(`🥁 *BPM*\n${f.bpm}`, `🎵 *Key*\n${f.key}`),
         twoCol(`⚡ *Energy*\n${scoreBar(f.energy)}`, `💃 *Danceability*\n${f.danceability}%`),
         twoCol(`🔊 *Loudness*\n${f.loudness} dB`, `😊 *Valence*\n${f.valence}%`),
         divider(),
         section('🎛️ *How to achieve this sound:*'),
         section(r || 'Error'),
         divider(),
         actions([btn('🆚 Compare Your Track', 'quick_compare', 'primary')]),
         context('Type /wavmind compare to compare your track against this reference'),
       ],
     });
   } else {
     const r = await askAI(`Blueprint for "${q}". Tempo, key, drums, bass, melody, mix approach.`);
     await respond({ blocks: [header('🎵 Reference Analysis'), section(`*${q}*`), divider(), section(r || 'Error'), context('Try format: Song Name - Artist Name')] });
   }
   return;
 }

 // ─── FEEDBACK ────────────────────────────────────────
 if (lower.startsWith('feedback')) {
   const rest = input.slice(8).trim();
   const bpmM = rest.match(/bpm[:\s]+(\d+)/i); const keyM = rest.match(/key[:\s]+([\w#b_]+)/i);
   if (bpmM && keyM) {
     const bpm = parseInt(bpmM[1]); const key = keyM[1].replace(/_/g,' ');
     const stored = global.pendingAnalysis?.[command.channel_id];
     await respond({ blocks: [header('🎚️ Generating Deep Mix Feedback...'), twoCol(`🥁 *BPM*\n${bpm}`, `🎵 *Key*\n${key}`), context('⏳')] });
     const ctx = stored ? `Energy: ${stored.energy}%, Brightness: ${stored.brightness}, Bass: ${stored.bass_ratio}%` : '';
     const r = await askAI(`Professional mix feedback: BPM ${bpm}, Key ${key}. ${ctx}. EQ, compression, arrangement. Real plugin names.`);
     if (global.pendingAnalysis?.[command.channel_id]) delete global.pendingAnalysis[command.channel_id];
     await respond({ blocks: [header('🎛️ Deep Mix Feedback'), twoCol(`🥁 *BPM*\n${bpm}`, `🎵 *Key*\n${key}`), stored ? twoCol(`⚡ *Energy*\n${scoreBar(stored.energy)}`, `🔊 *Bass*\n${stored.bass_ratio}%`) : divider(), divider(), section(r || 'Error'), actions([btn('🆚 Compare with Reference', 'quick_compare')])] });
     return;
   }
   if (!rest) { await respond({ blocks: [header('🎚️ Mix Feedback'), section('Type: /wavmind feedback my trap beat at 140bpm feels muddy\n\nAfter uploading audio:\nType: /wavmind feedback bpm:140 key:F_minor')] }); return; }
   await respond({ blocks: [header('🎚️ Analyzing...'), section(`_"${rest}"_`), context('⏳')] });
   const r = await askAI(`Professional mixing feedback for: "${rest}". EQ, compression, stereo width. Clear sections with emojis.`);
   await respond({ blocks: [header('🎚️ Mix Feedback'), section(`_${rest}_`), divider(), section(r || 'Error'), divider(), actions([btn('🆚 Compare with Reference', 'quick_compare')]), context('Upload MP3/WAV then type /wavmind feedback bpm:140 key:F_minor')] });
   return;
 }

 // ─── LABEL ───────────────────────────────────────────
 if (lower.startsWith('label')) {
   const desc = input.slice(5).trim();
   if (!desc) { await respond({ blocks: [header('🎯 Label Evaluation'), section('Type: /wavmind label dark trap 140bpm heavy 808s melodic piano')] }); return; }
   await respond({ blocks: [header('🎯 A&R Evaluation...'), section(`_"${desc}"_`), context('⏳')] });
   const bpmMatch = desc.match(/(\d+)\s*(bpm|tempo)?/i);
   const bpmContext = bpmMatch ? `Note: ${bpmMatch[1]} BPM is ${parseInt(bpmMatch[1]) < 70 ? 'very slow/ambient' : parseInt(bpmMatch[1]) < 90 ? 'slow/relaxed' : parseInt(bpmMatch[1]) < 110 ? 'mid-tempo' : parseInt(bpmMatch[1]) < 130 ? 'moderate' : parseInt(bpmMatch[1]) < 150 ? 'fast/energetic' : 'very fast/aggressive'} for music production context.` : '';
   const r = await askAI(`Senior A&R executive evaluation for this track: "${desc}". ${bpmContext}
Give honest assessment with these sections:
• Commercial Potential: X/10
• Playlist Potential: Low/Medium/High  
• Target Audience
• Strengths (2-3 specific points)
• Weaknesses (2-3 specific points)
• Verdict: Pass / Consider / Strong Interest

Reference the BPM and genre accurately in your assessment.`);
   await respond({ blocks: [header('🎯 Label Evaluation'), section(`_${desc}_`), divider(), section(r || 'Error'), context('Type /wavmind release [description] for release readiness check')] });
   return;
 }

 // ─── ARTIST ──────────────────────────────────────────
 if (lower.startsWith('artist')) {
   const artists = input.slice(6).trim();
   if (!artists) { await respond({ blocks: [header('🎤 Artist Comparison'), section('Type: /wavmind artist Drake and Travis Scott\nType: /wavmind artist Kanye vs Tyler the Creator')] }); return; }
   await respond({ blocks: [header('🔍 Comparing Artists...'), context('⏳')] });
   let a1, a2;
   if (artists.toLowerCase().includes(' and ')) { [a1,a2] = artists.split(/\s+and\s+/i).map(s=>s.trim()); }
   else if (artists.toLowerCase().includes(' vs ')) { [a1,a2] = artists.split(/\s+vs\s+/i).map(s=>s.trim()); }
   else { const w=artists.split(' '); const m=Math.ceil(w.length/2); a1=w.slice(0,m).join(' '); a2=w.slice(m).join(' '); }
   const [s1,s2] = await Promise.all([getArtistStats(a1), getArtistStats(a2)]);
   if (!s1||!s2) { await respond({ blocks: [header('❗ Not Found'), section('Type: /wavmind artist Drake and Travis Scott')] }); return; }
   const ai = await askAI(`Compare: ${s1.name} (BPM ${s1.bpm}, Energy ${s1.energy}%, Key ${s1.key}) vs ${s2.name} (BPM ${s2.bpm}, Energy ${s2.energy}%, Key ${s2.key}). Key differences, how to blend.`);
   await respond({
     blocks: [
       header('🎤 Artist Comparison'),
       section(`*${s1.name}* vs *${s2.name}*`),
       divider(),
       { type: 'section', fields: [{ type: 'mrkdwn', text: `*${s1.name}*` }, { type: 'mrkdwn', text: `*${s2.name}*` }] },
       { type: 'section', fields: [{ type: 'mrkdwn', text: `🥁 BPM: *${s1.bpm}*` }, { type: 'mrkdwn', text: `🥁 BPM: *${s2.bpm}*` }] },
       { type: 'section', fields: [{ type: 'mrkdwn', text: `⚡ Energy: *${s1.energy}%*` }, { type: 'mrkdwn', text: `⚡ Energy: *${s2.energy}%*` }] },
       { type: 'section', fields: [{ type: 'mrkdwn', text: `💃 Dance: *${s1.danceability}%*` }, { type: 'mrkdwn', text: `💃 Dance: *${s2.danceability}%*` }] },
       { type: 'section', fields: [{ type: 'mrkdwn', text: `🔊 Loud: *${s1.loudness}dB*` }, { type: 'mrkdwn', text: `🔊 Loud: *${s2.loudness}dB*` }] },
       { type: 'section', fields: [{ type: 'mrkdwn', text: `🎵 Key: *${s1.key}*` }, { type: 'mrkdwn', text: `🎵 Key: *${s2.key}*` }] },
       divider(),
       section(ai || 'Error'),
     ],
   });
   return;
 }

 // ─── DAW ─────────────────────────────────────────────
 if (lower.startsWith('daw')) {
   const dawInput = input.slice(3).trim();
   if (!dawInput) { await respond({ blocks: [header('🎹 DAW Help'), section('Type: /wavmind daw fl studio sidechain 808\nType: /wavmind daw ableton warp audio\nType: /wavmind daw logic pro flex pitch\nType: /wavmind daw pro tools set up sessions'), context('FL Studio · Ableton · Logic Pro · Pro Tools · Cubase · Studio One · GarageBand · Reaper')] }); return; }
   const dawList = [
     { name: 'FL Studio', keywords: ['fl studio','fl','fruity loops'] },
     { name: 'Ableton Live', keywords: ['ableton','ableton live','live'] },
     { name: 'Logic Pro', keywords: ['logic','logic pro','logic pro x'] },
     { name: 'Pro Tools', keywords: ['pro tools','protools'] },
     { name: 'Cubase', keywords: ['cubase'] },
     { name: 'Studio One', keywords: ['studio one','studio 1'] },
     { name: 'GarageBand', keywords: ['garageband','garage band'] },
     { name: 'Reason', keywords: ['reason'] },
     { name: 'Bitwig', keywords: ['bitwig'] },
     { name: 'Reaper', keywords: ['reaper'] },
   ];
   let detectedDAW = null; let question = dawInput;
   for (const daw of dawList) {
     for (const kw of daw.keywords) {
       if (dawInput.toLowerCase().startsWith(kw)) { detectedDAW = daw.name; question = dawInput.slice(kw.length).trim(); break; }
     }
     if (detectedDAW) break;
   }
   if (!detectedDAW) { await respond({ blocks: [header('❗ DAW Not Recognized'), section('Type: /wavmind daw fl studio sidechain 808'), context('FL Studio · Ableton · Logic Pro · Pro Tools · Cubase · Studio One')] }); return; }
   await respond({ blocks: [header(`🎹 ${detectedDAW} Help`), section(`*Question:* ${question}`), context('⏳')] });
   const [tav, ai] = await Promise.all([tavilySearch(`${detectedDAW} ${question} tutorial step by step`), askAI(`Expert ${detectedDAW} instructor. Answer: "${question}". Numbered steps. Bold key terms.`)]);
   const blocks = [header(`🎹 ${detectedDAW}: ${question}`), divider(), section('🤖 *AI Answer:*'), section(ai || 'Error')];
   if (tav?.answer) blocks.push(divider(), section('🌐 *From the Web:*'), section(tav.answer));
   if (tav?.results?.length) blocks.push(divider(), section('📚 *Resources:*'), section(tav.results.slice(0,4).map(r=>`• <${r.url}|${r.title}>`).join('\n')));
   await respond({ blocks });
   return;
 }

 // ─── COLLAB ──────────────────────────────────────────
 if (lower.startsWith('collab')) {
   const trackName = input.slice(6).trim().replace(/['"]/g,'') || 'Untitled';
   if (getCollabSession(command.channel_id)) { await respond({ blocks: [header('⚠️ Session Active'), section('Type /wavmind end to finish first')] }); return; }
   startCollabSession(command.channel_id, trackName, userId);
   await respond({ response_type: 'in_channel', blocks: [header('🤝 Collab Session Started'), section(`*Track:* "${trackName}"\n*By:* <@${userId}>`), divider(), section('Type: /wavmind idea [idea]\nType: /wavmind note [feedback]\nType: /wavmind decided [decision]\nType: /wavmind summary\nType: /wavmind end'), context(`Session active for "${trackName}"`)] });
   return;
 }

 if (lower.startsWith('idea ')) { const t=input.slice(5).trim(); const s=getCollabSession(command.channel_id); if(!s){await respond({blocks:[header('❗ No Session'),section('Type: /wavmind collab [track name]')]}); return;} s.ideas.push({text:t,user:userId,time:new Date().toISOString()}); await respond({response_type:'in_channel',blocks:[header('💡 Idea Logged'),section(`*"${t}"*\n— <@${userId}>`),context(`${s.ideas.length} ideas for "${s.trackName}"`)]}); return; }
 if (lower.startsWith('note ')) { const t=input.slice(5).trim(); const s=getCollabSession(command.channel_id); if(!s){await respond({blocks:[header('❗ No Session'),section('Type: /wavmind collab [track name]')]}); return;} s.feedback.push({text:t,user:userId,time:new Date().toISOString()}); await respond({response_type:'in_channel',blocks:[header('📝 Note Logged'),section(`*"${t}"*\n— <@${userId}>`),context(`${s.feedback.length} notes for "${s.trackName}"`)]}); return; }
 if (lower.startsWith('decided ')) { const t=input.slice(8).trim(); const s=getCollabSession(command.channel_id); if(!s){await respond({blocks:[header('❗ No Session'),section('Type: /wavmind collab [track name]')]}); return;} s.decisions.push({text:t,user:userId,time:new Date().toISOString()}); await respond({response_type:'in_channel',blocks:[header('✅ Decision Logged'),section(`*"${t}"*\n— <@${userId}>`),context(`${s.decisions.length} decisions for "${s.trackName}"`)]}); return; }
 if (lower === 'summary') { const s=getCollabSession(command.channel_id); if(!s){await respond({blocks:[header('❗ No Session')]}); return;} const r=await askAI(`Summarize collab for "${s.trackName}": IDEAS: ${s.ideas.map(i=>i.text).join(', ')||'None'} NOTES: ${s.feedback.map(f=>f.text).join(', ')||'None'} DECISIONS: ${s.decisions.map(d=>d.text).join(', ')||'None'}. Overview, direction, next steps.`); await respond({response_type:'in_channel',blocks:[header('📋 Summary'),section(`*"${s.trackName}"*`),divider(),twoCol(`💡 ${s.ideas.length} ideas`,`📝 ${s.feedback.length} notes`),twoCol(`✅ ${s.decisions.length} decisions`,`⏱️ ${new Date(s.startedAt).toLocaleTimeString()}`),divider(),section(r||'Error')]}); return; }
 if (lower === 'end') { const s=getCollabSession(command.channel_id); if(!s){await respond({blocks:[header('❗ No Active Session')]}); return;} const r=await askAI(`Final report for "${s.trackName}": IDEAS: ${s.ideas.map(i=>i.text).join(', ')||'None'} NOTES: ${s.feedback.map(f=>f.text).join(', ')||'None'} DECISIONS: ${s.decisions.map(d=>d.text).join(', ')||'None'}. Overview, decisions, action items.`); endCollabSession(command.channel_id); await respond({response_type:'in_channel',blocks:[header('🏁 Session Complete'),section(`*"${s.trackName}"*`),divider(),section(r||'Error'),context('Type /wavmind collab [name] for new session')]}); return; }

 // ─── PRODUCTION TOOLS ────────────────────────────────
 if (lower.startsWith('ideas')) { const genre=input.slice(5).trim()||'general'; const r=await askAI(`5 creative track ideas for "${genre}". Format: 🎵 *Title* — concept.`); await respond({blocks:[header('🎵 Track Ideas'),section(`*Genre:* ${genre}`),divider(),section(r||'Error')]}); return; }
 if (lower.startsWith('bpm')) { const mood=input.slice(3).trim()||'general'; const r=await askAI(`For "${mood}": ideal BPM range, best keys, chord progressions, song structure. Specific numbers.`); await respond({blocks:[header('🥁 BPM & Key'),section(`*Genre:* ${mood}`),divider(),section(r||'Error')]}); return; }
 if (lower.startsWith('chords')) { const q=input.slice(6).trim()||'C minor trap'; const r=await askAI(`3 chord progressions for "${q}". Each: chords, Roman numerals, feel, melody note.`); await respond({blocks:[header('🎹 Chord Progressions'),section(`*${q}*`),divider(),section(r||'Error')]}); return; }
 if (lower.startsWith('tips')) { const topic=input.slice(4).trim()||'music production'; const r=await askAI(`5 professional tips about "${topic}". Real techniques and plugin names.`); await respond({blocks:[header('💡 Production Tips'),section(`*${topic}*`),divider(),section(r||'Error')]}); return; }
 if (lower.startsWith('release')) { const desc=input.slice(7).trim(); if(!desc){await respond({blocks:[header('❗ Missing'),section('Type: /wavmind release Trap beat 140bpm mixed')]}); return;} const r=await askAI(`Release readiness for: "${desc}". Mix Quality, Loudness LUFS, Metadata, Distribution, Score X/10. Checklist ✅ or ⚠️.`); await respond({blocks:[header('✅ Release Readiness'),section(`_${desc}_`),divider(),section(r||'Error')]}); return; }
 if (lower==='mcp') { const base=`https://${process.env.RAILWAY_PUBLIC_DOMAIN||'your-url.railway.app'}`; await respond({blocks:[header('🔌 MCP Server'),section(`${base}/health\n${base}/mcp/tools\n${base}/mcp/execute (POST)`),context('Compatible with Claude, GPT and any MCP client')]}); return; }

 // ─── GENERAL ─────────────────────────────────────────
 await respond({ blocks: [header('🤔 On it...'), context('⏳')] });
 const response = await askAI(`You are Wavmind, expert AI for music producers. Answer: "${input}"`);
 await respond({ blocks: [header('🎛️ Wavmind'), section(response||'Error'), context('Type /wavmind for all features · DM me to chat naturally')] });
});

// ─── START ────────────────────────────────────────────────
(async () => {
 await app.start();
 console.log('🎛️ Wavmind Agent is running!');
 startMCPServer();
 startScheduler(app.client);
})();
