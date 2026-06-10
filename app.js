require('dotenv').config();
const { App } = require('@slack/bolt');
const Groq = require('groq-sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const http = require('http');

// ─── CRASH PROTECTION ─────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('uncaughtException (handled):', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection (handled):', reason?.message || reason);
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

app.error(async (error) => {
  console.error('Bolt error (handled):', error?.message || error);
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── PERSISTENT STORAGE ───────────────────────────────────
const REMINDERS_FILE = '/tmp/wavmind_reminders.json';
const STATS_FILE     = '/tmp/wavmind_stats.json';
const PROJECTS_FILE  = '/tmp/wavmind_projects.json';
const PREFS_FILE     = '/tmp/wavmind_prefs.json';

global._mem = global._mem || { reminders:{}, stats:{}, projects:{}, prefs:{} };

function loadFile(file, key) {
  if (Object.keys(global._mem[key]).length > 0) return global._mem[key];
  try { if (fs.existsSync(file)) { const d = JSON.parse(fs.readFileSync(file,'utf8')); global._mem[key]=d; return d; } }
  catch(e){ console.error('load',key,e.message); }
  return {};
}
function saveFile(file, data, key) {
  global._mem[key] = data;
  try { fs.writeFileSync(file, JSON.stringify(data,null,2)); } catch(e){ console.error('save',key,e.message); }
}

global.pendingReminders = loadFile(REMINDERS_FILE,'reminders');
global.weeklyStats      = loadFile(STATS_FILE,'stats');
global.userProjects     = loadFile(PROJECTS_FILE,'projects');
global.userPrefs        = loadFile(PREFS_FILE,'prefs');
global.userUploads      = global.userUploads || {};
global.samplePages      = global.samplePages || {};
global.compareSessions  = global.compareSessions || {};
global.collabSessions   = global.collabSessions || {};
global.userFlow         = global.userFlow || {};
global.pendingAnalysis  = global.pendingAnalysis || {};

const saveR = () => saveFile(REMINDERS_FILE, global.pendingReminders, 'reminders');
const saveS = () => saveFile(STATS_FILE,     global.weeklyStats,      'stats');
const saveP = () => saveFile(PROJECTS_FILE,  global.userProjects,     'projects');
const savePr= () => saveFile(PREFS_FILE,     global.userPrefs,        'prefs');

// ─── BLOCK KIT HELPERS ────────────────────────────────────
const divider = () => ({ type:'divider' });
const header  = t  => ({ type:'header', text:{ type:'plain_text', text:t, emoji:true } });
const section = t  => ({ type:'section', text:{ type:'mrkdwn', text:t } });
// twoCol: never pass empty string — default to dash
const twoCol  = (l,r) => ({ type:'section', fields:[
  { type:'mrkdwn', text: l||'—' },
  { type:'mrkdwn', text: r||'—' }
]});
const ctx     = t  => ({ type:'context', elements:[{ type:'mrkdwn', text:t }] });
const btn     = (text,actionId,style) => { const b={type:'button',text:{type:'plain_text',text,emoji:true},action_id:actionId}; if(style)b.style=style; return b; };
const actions = btns => ({ type:'actions', elements:btns });

// ─── HELPERS ──────────────────────────────────────────────
function scoreBar(pct) {
  const p = Math.max(0,Math.min(100,pct||0));
  const filled = Math.round(p/10);
  const col = p>=80?'🟢':p>=50?'🟡':'🔴';
  return col.repeat(filled)+'⚪'.repeat(10-filled)+` ${p}%`;
}
function daysUntil(iso) {
  if(!iso) return null;
  const t=new Date(); t.setHours(0,0,0,0);
  const d=new Date(iso); d.setHours(0,0,0,0);
  return Math.round((d-t)/(86400000));
}
function deadlineEmoji(days) {
  if(days===null) return '📅';
  if(days<0) return '🔴'; if(days<=2) return '🔴'; if(days<=7) return '🟡'; return '🟢';
}
function daysPhrase(days) {
  if(days===null) return 'no deadline';
  if(days<0) return `overdue by ${Math.abs(days)}d`;
  if(days===0) return 'due TODAY';
  if(days===1) return 'due tomorrow';
  return `due in ${days} days`;
}
function todayStr(){ return new Date().toISOString().slice(0,10); }
function loudnessVerdict(lufs) {
  if(lufs===undefined||lufs===null) return 'unknown';
  if(lufs>-7) return `${lufs} LUFS — very loud/over-compressed`;
  if(lufs>-11) return `${lufs} LUFS — loud, club/master level`;
  if(lufs>=-15) return `${lufs} LUFS — streaming-ready ✅`;
  if(lufs>=-20) return `${lufs} LUFS — a bit quiet, master louder`;
  return `${lufs} LUFS — needs mastering`;
}

// ─── FLEXIBLE DATE PARSER (day-first) ────────────────────
const MMAP={jan:0,january:0,feb:1,february:1,mar:2,march:2,apr:3,april:3,may:4,jun:5,june:5,jul:6,july:6,aug:7,august:7,sep:8,sept:8,september:8,oct:9,october:9,nov:10,november:10,dec:11,december:11};
function parseDate(s) {
  if(!s) return null;
  s=s.trim().toLowerCase().replace(/(\d+)(st|nd|rd|th)/g,'$1').replace(/,/g,' ').trim();
  const now=new Date();
  // ISO: 2026-06-15
  let m=s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if(m) return mk(+m[1],+m[2]-1,+m[3]);
  // DD/MM/YYYY or DD/MM (day first)
  m=s.match(/^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2,4}))?$/);
  if(m){
    let [,d,mo,yr]=m; d=+d; mo=+mo-1; yr=yr?(+yr<100?+yr+2000:+yr):now.getFullYear();
    if(mo>11&&d<=12){const t=d;d=mo+1;mo=t-1;}
    return mk(yr,mo,d);
  }
  // "12 june 2026" etc
  const toks=s.split(/\s+/);
  let day=null,mon=null,yr=null;
  for(const t of toks){
    if(/^\d{4}$/.test(t)) yr=+t;
    else if(/^\d{1,2}$/.test(t)){if(day===null)day=+t;}
    else if(MMAP[t]!==undefined) mon=MMAP[t];
  }
  if(mon!==null&&day!==null) return mk(yr||now.getFullYear(),mon,day);
  const d=new Date(s); return isNaN(d)?null:d;
  function mk(y,mo,da){const d=new Date(y,mo,da,12);return isNaN(d)?null:d;}
}

// ─── PROJECT MODEL ────────────────────────────────────────
const SESSION_KEYS=['recording','mixing','mastering','artwork','release','promotion'];
function sessionLabel(k){
  return {recording:'🎙️ Recording',mixing:'🎚️ Mixing',mastering:'🔊 Mastering',artwork:'🎨 Artwork',release:'🚀 Release',promotion:'📣 Promotion'}[k]||k;
}
function createProject(userId,name){
  if(!global.userProjects[userId]) global.userProjects[userId]=[];
  const sessions={};
  for(const k of SESSION_KEYS) sessions[k]={done:false,deadline:null};
  const p={id:Date.now().toString(),name,createdAt:new Date().toISOString(),sessions,completed:false,lastDailyReminder:null};
  global.userProjects[userId].push(p);
  saveP(); return p;
}
const getProjects      = uid => global.userProjects[uid]||[];
const getActiveProject = uid => getProjects(uid).find(p=>!p.completed)||null;
function setDeadline(uid,sk,iso){
  const p=getActiveProject(uid); if(!p) return null;
  p.sessions[sk].deadline=iso; saveP(); return p;
}
function markDone(uid,sk){
  const p=getActiveProject(uid); if(!p) return null;
  p.sessions[sk].done=true; saveP(); return p;
}
function completeProject(uid){
  const p=getActiveProject(uid); if(!p) return null;
  p.completed=true; saveP(); return p;
}
function projectHealth(p){
  const vals=Object.values(p.sessions);
  const done=vals.filter(s=>s.done).length;
  return {done,total:vals.length,pct:Math.round(done/vals.length*100)};
}
function projectSessionsText(p){
  return SESSION_KEYS.map(k=>{
    const s=p.sessions[k];
    const tick=s.done?'✅':'☐';
    if(!s.deadline) return `${tick} *${sessionLabel(k)}* — _no deadline_`;
    const days=daysUntil(s.deadline);
    return `${tick} *${sessionLabel(k)}* — ${deadlineEmoji(days)} ${daysPhrase(days)} (${new Date(s.deadline).toLocaleDateString()})`;
  }).join('\n');
}
function buildProjectBlocks(p){
  const h=projectHealth(p);
  return [
    header(`📋 ${p.name}`),
    section(`*Progress:* ${scoreBar(h.pct)}   *${h.done}/${h.total} sessions done*`),
    divider(),
    section(projectSessionsText(p)),
    divider(),
    section('*Set deadlines* (any format works):\nrecording 12/06/2026 · mixing 15/06/2026 · mastering 18/06/2026\nartwork 20/06/2026 · release 25/06/2026 · promotion 28/06/2026'),
    section('*Mark done:* `done mixing`  ·  *Finish project:* `complete project`'),
  ];
}

// ─── GROQ AI ──────────────────────────────────────────────
async function askAI(prompt) {
  try {
    const r=await groq.chat.completions.create({
      model:'llama-3.1-8b-instant',
      messages:[
        {role:'system',content:'You are Wavmind, expert AI for music producers. Format using Slack mrkdwn. *bold* for emphasis, • for bullets. Never use ** or # headers.'},
        {role:'user',content:prompt}
      ],
      max_tokens:1024,
    });
    let t=r.choices[0].message.content;
    t=t.replace(/#{1,6}\s+/g,'').replace(/\*\*([^*]+)\*\*/g,'*$1*').replace(/^-\s+/gm,'• ');
    return t;
  } catch(e){console.error('Groq:',e.message);return null;}
}

// ─── TAVILY ───────────────────────────────────────────────
async function tavilySearch(query) {
  try {
    const r=await axios.post('https://api.tavily.com/search',
      {api_key:process.env.TAVILY_API_KEY,query,search_depth:'basic',max_results:5,include_answer:true},
      {timeout:10000});
    return {answer:r.data.answer||null,results:(r.data.results||[]).map(x=>({title:x.title,url:x.url}))};
  } catch(e){console.error('Tavily:',e.message);return null;}
}

// ─── FREESOUND ────────────────────────────────────────────
const ENHANCE={
  piano:['piano melody','piano chord','piano loop','piano riff'],
  synth:['synth pad','synth lead','synth arp','synthesizer'],
  bass:['bass line','bass riff','808 bass','sub bass'],
  guitar:['guitar riff','electric guitar','acoustic guitar'],
  drums:['drum loop','drum beat','trap drums','drum kit'],
  strings:['string ensemble','violin','cello','orchestral strings'],
  flute:['flute melody','pan flute','flute loop'],
  vocal:['vocal chop','vocal sample','vocal melody'],
  ambient:['ambient pad','ambient texture','ambient drone'],
  trumpet:['trumpet melody','brass','trumpet loop'],
  saxophone:['sax melody','saxophone jazz','alto sax'],
};
function enhanceQ(q){
  const l=q.toLowerCase();
  for(const [k,opts] of Object.entries(ENHANCE)) if(l.includes(k)) return opts[Math.floor(Math.random()*opts.length)];
  return q;
}
function nextPage(uid,q){
  const key=`${uid}_${q.toLowerCase().trim()}`;
  if(!global.samplePages[key]) global.samplePages[key]=[];
  const used=global.samplePages[key];
  let attempts=0,page;
  do{page=Math.floor(Math.random()*8)+1;attempts++;}while(used.includes(page)&&attempts<20);
  used.push(page); if(used.length>6) used.shift();
  global.samplePages[key]=used; return page;
}
async function searchFreesound(query,uid=null){
  try{
    const clean=query.replace(/\b(loop|loops|sample|samples|pack|packs|free|download|audio)\b/gi,'').replace(/\s+/g,' ').trim()||query;
    const enh=enhanceQ(clean);
    const page=uid?nextPage(uid,query):Math.floor(Math.random()*8)+1;
    const base=`https://freesound.org/apiv2/search/text/?token=${process.env.FREESOUND_API_KEY}&format=json&page_size=10&fields=id,name,tags,duration,license,username,previews,avg_rating,num_downloads&filter=duration:[1+TO+30]`;
    const url=`${base}&query=${encodeURIComponent(enh)}&page=${page}`;
    const r=await axios.get(url,{timeout:10000});
    let res=r.data.results||[];
    if(!res.length&&page>1){const fb=await axios.get(`${base}&query=${encodeURIComponent(enh)}&page=1`,{timeout:10000});res=fb.data.results||[];}
    if(!res.length){const sp=query.split(' ')[0];if(sp!==query){const sr=await axios.get(`${base}&query=${encodeURIComponent(sp)}&page=1`,{timeout:10000});res=sr.data.results||[];}}
    if(!res.length) return null;
    return res.sort(()=>Math.random()-0.5).map(s=>({
      id:s.id,name:s.name,
      duration:Math.round((s.duration||0)*10)/10,
      license:s.license?.includes('publicdomain')?'CC0 — Free':'CC Attribution',
      username:s.username,
      preview:s.previews?.['preview-hq-mp3']||s.previews?.['preview-lq-mp3']||null,
      url:`https://freesound.org/people/${s.username}/sounds/${s.id}/`,
      downloads:s.num_downloads||0,
      rating:s.avg_rating?Math.round(s.avg_rating*10)/10:0,
      tags:(s.tags||[]).slice(0,6).join(' · '),
    }));
  } catch(e){console.error('Freesound:',e.message);return null;}
}
async function buildSamplesBlocks(query,uid){
  const sounds=await searchFreesound(query,uid);
  if(!sounds?.length) return [header('❗ No Results'),section(`No sounds for *"${query}"*\n\nTry: piano · drums · bass · guitar · synth`),section(`🔗 *<https://freesound.org/search/?q=${encodeURIComponent(query)}|Browse Freesound>*`)];
  const tip=await askAI(`Producer needs "${query}" samples. 2 quick tips under 40 words. Bullets.`);
  const blocks=[header(`🎵 Free Samples: "${query}"`),section(`*${sounds.length} sounds* — all free · _Search again for different results_`),ctx('🔊 Listen to preview · 📥 Download for file'),divider()];
  sounds.forEach((s,i)=>{
    blocks.push(section(`*${i+1}. ${s.name}*\n⏱️ *${s.duration}s* · ⭐ *${s.rating}/5* · 📥 *${s.downloads.toLocaleString()}*\n📄 ${s.license} · 👤 ${s.username}\n🏷️ ${s.tags}\n\n${s.preview?`🔊 *<${s.preview}|▶ Listen>*     `:''}🔗 *<${s.url}|📥 Download>*`));
    if(i<sounds.length-1) blocks.push(divider());
  });
  if(tip) blocks.push(divider(),header(`💡 Tips for "${query}"`),section(tip));
  blocks.push(divider(),section(`🔗 *<https://freesound.org/search/?q=${encodeURIComponent(query)}|Browse more on Freesound>*`),ctx('Creative Commons · Search again for different sounds'));
  return blocks;
}

// ─── SPOTIFY ──────────────────────────────────────────────
async function getSpotifyToken(){
  const r=await axios.post('https://accounts.spotify.com/api/token','grant_type=client_credentials',{
    headers:{'Content-Type':'application/x-www-form-urlencoded',Authorization:'Basic '+Buffer.from(process.env.SPOTIFY_CLIENT_ID+':'+process.env.SPOTIFY_CLIENT_SECRET).toString('base64')}
  });
  return r.data.access_token;
}
async function getTrackFeatures(name){
  try{
    const token=await getSpotifyToken();
    const q=name.trim().replace(/\s+/g,' ');
    let sr=await axios.get('https://api.spotify.com/v1/search',{headers:{Authorization:`Bearer ${token}`},params:{q,type:'track',limit:1,market:'US'}});
    let track=sr.data.tracks.items[0];
    if(!track){
      const simple=q.split(/[-–]|by/i)[0].trim();
      sr=await axios.get('https://api.spotify.com/v1/search',{headers:{Authorization:`Bearer ${token}`},params:{q:simple,type:'track',limit:1,market:'US'}});
      track=sr.data.tracks.items[0];
      if(!track) return null;
    }
    const f=await axios.get(`https://api.spotify.com/v1/audio-features/${track.id}`,{headers:{Authorization:`Bearer ${token}`}});
    const keys=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    return {name:track.name,artist:track.artists[0].name,bpm:Math.round(f.data.tempo),key:keys[f.data.key]+' '+['Minor','Major'][f.data.mode],energy:Math.round(f.data.energy*100),danceability:Math.round(f.data.danceability*100),loudness:f.data.loudness.toFixed(1),valence:Math.round(f.data.valence*100)};
  }catch(e){console.error('Spotify track:',e.message);return null;}
}
async function getArtistStats(name){
  try{
    const token=await getSpotifyToken();
    const sr=await axios.get('https://api.spotify.com/v1/search',{headers:{Authorization:`Bearer ${token}`},params:{q:name,type:'track',limit:5}});
    const tracks=sr.data.tracks.items;
    if(!tracks.length) return null;
    const fRes=await Promise.all(tracks.map(t=>axios.get(`https://api.spotify.com/v1/audio-features/${t.id}`,{headers:{Authorization:`Bearer ${token}`}})));
    const feats=fRes.map(r=>r.data);
    const avg=k=>Math.round(feats.reduce((s,f)=>s+f[k],0)/feats.length);
    const keys=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    return {name,bpm:avg('tempo'),energy:Math.round(avg('energy')),danceability:Math.round(avg('danceability')),valence:Math.round(avg('valence')),loudness:(feats.reduce((s,f)=>s+f.loudness,0)/feats.length).toFixed(1),key:keys[Math.abs(avg('key'))%12]+' '+['Minor','Major'][avg('mode')>0?1:0]};
  }catch(e){console.error('Spotify artist:',e.message);return null;}
}
async function getNewReleases(genre,limit=6){
  try{
    const token=await getSpotifyToken();
    let r=await axios.get('https://api.spotify.com/v1/search',{headers:{Authorization:`Bearer ${token}`},params:{q:`genre:"${genre}"`,type:'album',limit:30,market:'US'}});
    let albums=r.data.albums?.items||[];
    if(!albums.length){r=await axios.get('https://api.spotify.com/v1/search',{headers:{Authorization:`Bearer ${token}`},params:{q:genre,type:'album',limit:30,market:'US'}});albums=r.data.albums?.items||[];}
    return albums.filter(a=>a.release_date).map(a=>({name:a.name,artist:a.artists?.[0]?.name||'Unknown',date:a.release_date,url:a.external_urls?.spotify||`https://open.spotify.com/album/${a.id}`,ts:new Date(a.release_date).getTime()||0})).sort((x,y)=>y.ts-x.ts).slice(0,limit);
  }catch(e){console.error('Releases:',e.message);return null;}
}

// ─── AUDIO ANALYSIS ───────────────────────────────────────
async function analyzeAudio(fileUrl,filename){
  const fp=path.join('/tmp',filename.replace(/[^a-zA-Z0-9._-]/g,'_'));
  try{
    const r=await axios.get(fileUrl,{headers:{Authorization:`Bearer ${process.env.SLACK_BOT_TOKEN}`},responseType:'arraybuffer',timeout:30000});
    fs.writeFileSync(fp,r.data);
    const out=execSync(`python3 analyze.py "${fp}"`,{timeout:90000}).toString().trim();
    if(fs.existsSync(fp)) fs.unlinkSync(fp);
    const a=JSON.parse(out);
    if(a.error){console.error('analyze.py error:',a.error);return{error:a.error};}
    return a;
  }catch(e){
    if(fs.existsSync(fp)) fs.unlinkSync(fp);
    console.error('analyzeAudio:',e.message);
    return{error:e.message};
  }
}
function trackUpload(uid,filename,analysis){
  if(!global.pendingReminders[uid]) global.pendingReminders[uid]=[];
  global.pendingReminders[uid].push({filename,analysis,uploadedAt:new Date().toISOString(),remindAt:new Date(Date.now()+24*3600000).toISOString(),sent:false});
  saveR();
  if(!global.userUploads[uid]) global.userUploads[uid]=[];
  global.userUploads[uid].push({filename,analysis,timestamp:new Date().toISOString()});
  if(!global.weeklyStats[uid]) global.weeklyStats[uid]={tracks:0,issues:[]};
  global.weeklyStats[uid].tracks++;
  if(analysis.lufs!==undefined&&analysis.lufs<-18) global.weeklyStats[uid].issues.push('Quiet master');
  if((analysis.low_pct||analysis.bass_ratio||0)>45) global.weeklyStats[uid].issues.push('Heavy low end');
  if(analysis.stereo_width!==undefined&&analysis.stereo_width<8) global.weeklyStats[uid].issues.push('Narrow stereo');
  saveS();
}

// ─── FEEDBACK ─────────────────────────────────────────────
async function handleFeedback(uid,send){
  const uploads=global.userUploads[uid]||[];
  const last=uploads[uploads.length-1];
  if(!last||!last.analysis||last.analysis.error){
    await send([header('🎚️ Mix Feedback'),section('Upload an MP3 or WAV first — then ask for feedback.\n\nI\'ll critique:\n• Vocal clarity\n• Kick & bass in the mix\n• Loudness vs industry standard\n• Spectral balance & frequency')],'Upload a track first');
    return;
  }
  const a=last.analysis;
  await send([header('🎚️ Analyzing your mix...'),ctx('⏳ This takes a few seconds')],'Analyzing');
  const hasFull=a.lufs!==undefined;
  const prompt=hasFull?`You are a professional mixing/mastering engineer. Give specific, actionable feedback on this track based on measured analysis. Do NOT ask for BPM or key.

MEASURED DATA for "${last.filename}":
• Integrated loudness: ${a.lufs} LUFS (streaming target ~-14 LUFS)
• Stereo width: ${a.stereo_width}% (${a.is_stereo?'stereo':'mono'})
• Spectral balance: low ${a.low_pct}% / mid ${a.mid_pct}% / high ${a.high_pct}%
• Spectral centroid: ${a.spectral_centroid} Hz
• Vocal clarity proxy: ${a.vocal_clarity}%
• Energy: ${a.energy}%

Cover these 4 areas with concrete fixes (EQ ranges in Hz, real plugin names):
1) Vocal clarity
2) Kick & bass in the mix
3) Loudness vs industry (too loud/quiet/ready?)
4) Spectral balance & frequency analysis
End with Top 3 priority fixes.`
  :`You are a professional mixing engineer. Give feedback on "${last.filename}": energy ${a.energy}%, brightness ${a.brightness}, bass ${a.bass_ratio}%. Cover: vocal clarity, kick & bass, loudness vs streaming (-14 LUFS), spectral balance. Real plugin names. Top 3 fixes at end.`;
  const r=await askAI(prompt);
  const blocks=[header('🎛️ Mix Feedback'),section(`🎵 *${last.filename}*`)];
  if(hasFull){
    blocks.push(twoCol(`🔊 *Loudness*\n${loudnessVerdict(a.lufs)}`,`🎚️ *Stereo Width*\n${a.stereo_width}%`));
    blocks.push(twoCol(`📊 *Low/Mid/High*\n${a.low_pct}% / ${a.mid_pct}% / ${a.high_pct}%`,`🎤 *Vocal Clarity*\n${a.vocal_clarity}%`));
  } else {
    blocks.push(twoCol(`⚡ *Energy*\n${scoreBar(a.energy)}`,`🔊 *Bass*\n${a.bass_ratio}%`));
  }
  blocks.push(divider(),section(r||'Could not generate feedback.'),divider(),actions([btn('🆚 Compare with Reference','quick_compare','primary')]));
  await send(blocks,'Mix feedback ready');
}

// ─── APP HOME (crash-fixed: no empty twoCol fields) ───────
async function publishHome(client,uid){
  try{
    const uploads=global.userUploads[uid]||[];
    const last=uploads[uploads.length-1];
    const stats=global.weeklyStats[uid];
    const proj=getActiveProject(uid);
    const prefs=global.userPrefs[uid]||{};
    const blocks=[section('*🎛️ Wavmind*\n_Your autonomous AI music production agent_'),divider()];

    if(proj){
      const h=projectHealth(proj);
      blocks.push(header('📋 Active Project'));
      blocks.push(section(`*${proj.name}*\n${scoreBar(h.pct)}   *${h.done}/${h.total} done*`));
      // Use single section (not twoCol) to avoid empty field crash
      blocks.push(section(projectSessionsText(proj)));
      blocks.push(actions([btn('📋 View Project','menu_main'),btn('🆚 Compare Tracks','quick_compare')]),divider());
    }

    if(last?.analysis&&!last.analysis.error){
      const a=last.analysis;
      const hasFull=a.lufs!==undefined;
      blocks.push(header('📊 Your Last Track'),section(`🎵 *${last.filename}*`));
      if(hasFull){
        blocks.push(twoCol(`⚡ *Energy*\n${scoreBar(a.energy)}`,`🔊 *Loudness*\n${a.lufs} LUFS`));
        blocks.push(twoCol(`🎚️ *Stereo*\n${a.stereo_width}%`,`📊 *L/M/H*\n${a.low_pct}/${a.mid_pct}/${a.high_pct}%`));
      } else {
        blocks.push(twoCol(`⚡ *Energy*\n${scoreBar(a.energy)}`,`🔊 *Bass*\n${a.bass_ratio}%`));
        blocks.push(twoCol(`🌈 *Brightness*\n${a.brightness}`,`⏱️ *Duration*\n${Math.floor(a.duration/60)}:${String(a.duration%60).padStart(2,'0')}`));
      }
      blocks.push(ctx(`_Scanned ${new Date(last.timestamp).toLocaleDateString()}_`));
      blocks.push(actions([btn('🆚 Compare','quick_compare','primary'),btn('🎚️ Feedback','quick_feedback')]),divider());
    }

    if(stats?.tracks>0){
      blocks.push(header('📈 This Week'),twoCol(`🎵 *Tracks*\n${stats.tracks}`,`⚠️ *Top Issue*\n${stats.issues[0]||'None'}`),divider());
    }

    blocks.push(
      header('💬 Talk to Me'),
      section('DM me naturally:\n• "start project"\n• "compare"\n• "feedback"\n• "find trap drums"\n• "new releases"\n• "teach me fl studio"'),
      divider(),
      header('🎛️ Commands'),
      twoCol('*📋 Projects*\nstart project\nshow project\ndone mixing','*🆚 Compare*\n/wavmind compare'),
      twoCol('*🎵 Samples*\n/wavmind samples piano\n/wavmind samples drums','*🎹 DAW Help*\n/wavmind daw fl studio [q]'),
      twoCol('*🎚️ Feedback*\n/wavmind feedback [describe]','*🔍 Reference*\n/wavmind reference [song]'),
      twoCol('*🎵 Releases*\n/wavmind releases\n/wavmind set genre trap','*🎓 DAW Guru*\nteach me ableton'),
      divider(),
      header('🤖 Autonomous Features'),
      section(`• *Daily project reminders* — as sessions approach\n• *24hr upload follow-up*\n• *New release alerts*${prefs.genre?` — *${prefs.genre}*`:''}\n• *Daily DAW lessons*${prefs.daw?` — *${prefs.daw}* (${prefs.skillLevel||'beginner'})`:''}\n• *MCP Server* — AI agents connect to Wavmind tools`),
      divider(),
      header('⚡ Powered By'),
      twoCol('🤖 *Groq AI* — Llama 3.1','🎵 *Spotify* — audio data'),
      twoCol('🔍 *Tavily* — real-time search','🎵 *Freesound* — 500K+ samples'),
      twoCol('🎧 *Librosa + pyloudnorm* — deep analysis','🔌 *MCP* — agent protocol'),
      divider(),
      ctx('🎛️ *Wavmind* — just talk to me naturally')
    );

    await client.views.publish({user_id:uid,view:{type:'home',blocks}});
  }catch(e){console.error('Home error:',e.message);}
}

app.event('app_home_opened',async({event,client})=>{
  await publishHome(client,event.user);
});

// ─── BUTTON HANDLERS ──────────────────────────────────────
app.action('menu_main',async({body,ack,client})=>{
  await ack();
  await client.chat.postMessage({channel:body.user.id,text:'Wavmind menu',blocks:getWelcomeBlocks()});
});
app.action('quick_compare',async({body,ack,client})=>{
  await ack();
  startCompare(body.user.id);
  await client.chat.postMessage({channel:body.user.id,text:'Comparison started',blocks:[header('🆚 Comparison Started'),section('*Step 1* — upload YOUR track\n*Step 2* — upload your REFERENCE track\n\nI auto-compare loudness, stereo, spectral balance & frequency, then recommend fixes.'),ctx('Type `cancel` to stop')]});
});
app.action('quick_feedback',async({body,ack,client})=>{
  await ack();
  await handleFeedback(body.user.id,async(bl,t)=>client.chat.postMessage({channel:body.user.id,text:t,blocks:bl}));
});
app.action('daw_guru',async({body,ack,client})=>{
  await ack();
  await client.chat.postMessage({channel:body.user.id,text:'DAW Guru',blocks:[header('🎓 DAW Guru'),section('Pick your level:'),actions([btn('🌱 Beginner','level_beginner','primary'),btn('⚡ Intermediate','level_intermediate'),btn('🔥 Advanced','level_advanced')])]});
});
['beginner','intermediate','advanced'].forEach(level=>{
  app.action(`level_${level}`,async({body,ack,client})=>{
    await ack();
    if(!global.userPrefs[body.user.id]) global.userPrefs[body.user.id]={};
    global.userPrefs[body.user.id].skillLevel=level; savePr();
    global.userFlow[body.user.id]={state:'awaiting_daw'};
    await client.chat.postMessage({channel:body.user.id,text:'Which DAW?',blocks:[header(`🎓 Level: ${level}`),section('Which DAW are you using?\n(e.g. *FL Studio*, *Ableton*, *Logic Pro*)\n\nJust type it below.')]});
  });
});
app.action('start_project',async({body,ack,client})=>{
  await ack();
  global.userFlow[body.user.id]={state:'awaiting_project_name'};
  await client.chat.postMessage({channel:body.user.id,text:'New project',blocks:[header('📋 New Project'),section('What\'s the name of your project?')]});
});

// ─── COMPARE SESSION ──────────────────────────────────────
const startCompare  = id=>{global.compareSessions[id]={status:'waiting_your_track',yourTrack:null,referenceTrack:null};return global.compareSessions[id];};
const getCompare    = id=>global.compareSessions[id]||null;
const clearCompare  = id=>{delete global.compareSessions[id];};

// ─── WELCOME BLOCKS ───────────────────────────────────────
function getWelcomeBlocks(){
  return [
    header('🎛️ Hey! I\'m Wavmind 👋'),
    section('Your autonomous AI music production agent.\n\n*Talk to me naturally:*\n• "start project" — plan a release with deadline reminders\n• upload a track — I scan loudness, stereo, spectral balance\n• "compare" — A/B your track vs a reference\n• "feedback" — mix critique on your last upload\n• "find trap drums" — free samples\n• "new releases" — latest drops in your genre\n• "teach me fl studio" — daily DAW lessons'),
    divider(),
    actions([btn('📋 Start a Project','start_project'),btn('🆚 Compare Tracks','quick_compare')]),
    actions([btn('🎵 Find Samples','menu_samples'),btn('🎓 DAW Guru','daw_guru')]),
    divider(),
    section('*Slash commands:*\n/wavmind compare · /wavmind feedback · /wavmind samples drums\n/wavmind reference [song] · /wavmind daw fl studio [q]\n/wavmind artist Drake and Travis Scott · /wavmind releases'),
    divider(),
    ctx('💡 DM me or @mention me — I understand plain English'),
  ];
}
app.action('menu_samples',async({body,ack,client})=>{
  await ack();
  await client.chat.postMessage({channel:body.user.id,text:'Samples',blocks:[header('🎵 Free Samples'),section('What samples do you need?\n\nType: /wavmind samples drums\nOr just DM me: "find me trap drums"'),ctx('500K+ Creative Commons sounds · Freesound.org')]});
});

// ─── PREFS ────────────────────────────────────────────────
function getPrefs(uid){if(!global.userPrefs[uid])global.userPrefs[uid]={};return global.userPrefs[uid];}

// ─── DM + CHANNEL HANDLER ─────────────────────────────────
app.message(async({message,say,client})=>{
  if(message.subtype||!message.text) return;
  const uid=message.user;
  const text=message.text.trim();
  const lower=text.toLowerCase();
  const send=async(blocks,t)=>say({blocks,text:t||'Wavmind'});

  if(message.channel_type==='im'){
    // Greetings
    if(['hi','hello','hey','start','help','menu'].includes(lower)){await send(getWelcomeBlocks(),'Welcome');return;}

    // ── FLOW STATES ──
    const flow=global.userFlow[uid];

    if(flow?.state==='awaiting_project_name'){
      delete global.userFlow[uid];
      const proj=createProject(uid,text.replace(/^["']|["']$/g,'')||'My Project');
      await send([
        header(`📋 ${proj.name} — Created!`),
        section(scoreBar(0)),
        divider(),
        section('*Set your deadlines.* Any date format works:\n\nrecording 12/06/2026\nmixing 15/06/2026\nmastering 18/06/2026\nartwork 20/06/2026\nrelease 25/06/2026\npromotion 28/06/2026'),
        ctx('🤖 I\'ll remind you daily as sessions get close'),
      ],'Project created');
      await publishHome(client,uid); return;
    }

    if(flow?.state==='awaiting_daw'){
      delete global.userFlow[uid];
      const p=getPrefs(uid);
      p.daw=text.replace(/^["']|["']$/g,'');
      p.dawLessons=true; p.lastLesson=null; savePr();
      const lesson=await askAI(`Daily micro-lesson for a ${p.skillLevel||'beginner'} ${p.daw} producer. One focused technique, 3-4 concrete steps, under 120 words.`);
      await send([header(`🎓 DAW Guru — ${p.daw}`),section(`Level: *${p.skillLevel}* · Daily lessons *enabled* ✅`),divider(),section(lesson||'Lesson coming tomorrow!'),ctx('I\'ll send a new lesson each day · DM me "stop lessons" to pause')],'DAW Guru enabled');
      return;
    }

    if(flow?.state==='awaiting_genre'){
      delete global.userFlow[uid];
      const p=getPrefs(uid);
      p.genre=text.replace(/^["']|["']$/g,''); p.releases=true; p.lastRelease=null; savePr();
      await send([header('🎵 New Release Alerts ✅'),section(`Genre set to *${p.genre}*. I'll DM you latest drops daily.`),divider(),section('Type "new releases" to see them now.')],'Genre set');
      return;
    }

    // ── DEADLINE LINE: "recording 12/06/2026" ──
    const dl=lower.match(/^(recording|mixing|mastering|artwork|release|promotion)\s+(.+)$/);
    if(dl){
      const proj=getActiveProject(uid);
      if(!proj){global.userFlow[uid]={state:'awaiting_project_name'};await send([header('📋 No Active Project'),section('Let\'s start one first. What\'s the project name?')],'No project');return;}
      const parsed=parseDate(dl[2]);
      if(!parsed){await send([header('❗ Couldn\'t read that date'),section(`Try: \`${dl[1]} 12/06/2026\` or \`${dl[1]} 15 June 2026\``)],'Bad date');return;}
      setDeadline(uid,dl[1],parsed.toISOString());
      const days=daysUntil(parsed.toISOString());
      await send([header(`📅 ${sessionLabel(dl[1])} deadline set`),section(`*${parsed.toLocaleDateString()}* — ${deadlineEmoji(days)} ${daysPhrase(days)}`),divider(),section(projectSessionsText(getActiveProject(uid))),ctx('Set another, or type "show project"')],'Deadline set');
      await publishHome(client,uid); return;
    }

    // ── PROJECT COMMANDS ──
    if(/^(start|new|create)\s+project/.test(lower)||lower==='start project'){
      global.userFlow[uid]={state:'awaiting_project_name'};
      await send([header('📋 New Project'),section('What\'s the name of your project?')],'Name your project'); return;
    }
    if(/(show|view|my)\s+project/.test(lower)||lower==='project'){
      const proj=getActiveProject(uid);
      if(!proj){global.userFlow[uid]={state:'awaiting_project_name'};await send([header('📋 No Active Project'),section('Let\'s start one. What\'s the project name?')],'No project');}
      else await send(buildProjectBlocks(proj),'Your project');
      return;
    }
    const doneM=lower.match(/^(?:mark\s+)?done\s+(recording|mixing|mastering|artwork|release|promotion)$/);
    if(doneM){
      const proj=getActiveProject(uid);
      if(!proj){await send([header('❗ No Active Project')],'No project');return;}
      markDone(uid,doneM[1]);
      const h=projectHealth(getActiveProject(uid));
      await send([header(`✅ ${sessionLabel(doneM[1])} done!`),section(`*${proj.name}*\n${scoreBar(h.pct)}`),divider(),section(h.done===h.total?'🎉 All sessions complete! Type `complete project`':`${h.done}/${h.total} done — keep going!`)],'Session done');
      await publishHome(client,uid); return;
    }
    if(/^complete project$|^finish project$/.test(lower)){
      const proj=getActiveProject(uid);
      if(!proj){await send([header('❗ No Active Project')],'No project');return;}
      completeProject(uid);
      await send([header('🎉 Project Complete!'),section(`*${proj.name}* is done — congrats! 🚀`),divider(),section('Start another: type `start project`')],'Complete');
      await publishHome(client,uid); return;
    }

    // ── DAW GURU ──
    if(/(teach|learn|tutor|daw guru|guru)/.test(lower)&&/(fl studio|ableton|logic|cubase|pro tools|studio one|reaper|bitwig|garageband|daw|me)/.test(lower)){
      await send([header('🎓 DAW Guru'),section('Pick your level:'),actions([btn('🌱 Beginner','level_beginner','primary'),btn('⚡ Intermediate','level_intermediate'),btn('🔥 Advanced','level_advanced')])],'Pick level'); return;
    }
    if(lower==='stop lessons'){const p=getPrefs(uid);p.dawLessons=false;savePr();await send([header('🎓 Lessons paused'),section('DM me "teach me [daw]" to resume.')],'Paused');return;}

    // ── NEW RELEASES ──
    if(/(new release|latest release|new music|new drops|latest drops)/.test(lower)){
      const p=getPrefs(uid);
      if(!p.genre){global.userFlow[uid]={state:'awaiting_genre'};await send([header('🎵 New Release Alerts'),section('What genre should I track?\n(e.g. *trap*, *lo-fi*, *house*, *afrobeats*)\n\nJust type it below.')],'Pick genre');return;}
      await sendReleases(uid,send); return;
    }
    if(/^set genre/.test(lower)){
      const g=text.replace(/^set genre/i,'').trim();
      if(g){const p=getPrefs(uid);p.genre=g;p.releases=true;p.lastRelease=null;savePr();await send([header('🎵 Genre set ✅'),section(`Tracking *${g}*. Type "new releases" to see drops now.`)],'Genre set');}
      else{global.userFlow[uid]={state:'awaiting_genre'};await send([section('What genre? Type it below.')],'Pick genre');}
      return;
    }

    // ── COMPARE ──
    if(/^compare/.test(lower)||lower==='compare'){
      startCompare(uid);
      await send([header('🆚 Comparison Mode'),section('*Step 1* — upload YOUR track\n*Step 2* — upload your REFERENCE track\n\nI auto-compare loudness, stereo width, spectral balance & frequency, then recommend fixes.'),ctx('Type `cancel` to stop')],'Compare started'); return;
    }
    if(lower==='cancel'){clearCompare(uid);await send([header('🗑️ Cancelled')],'Cancelled');return;}

    // ── FEEDBACK ──
    if(/feedback|critique|how.?s my mix|whats wrong|review my/.test(lower)){await handleFeedback(uid,send);return;}

    // ── SAMPLES ──
    if(/(sample|drum|piano|bass|guitar|synth|loop|808|snare|kick|vocal|pad|string|flute|brass|hi.?hat)/.test(lower)&&!/feedback|mix/.test(lower)){
      const q=text.replace(/find|search|get|i need|show me|give me|looking for|find me|search for|some|me/gi,'').trim()||'drums';
      await send([section(`🔍 Finding *${q}* samples...`),ctx('⏳')],'Searching');
      await send(await buildSamplesBlocks(q,uid),'Samples'); return;
    }

    // ── DAW HELP ──
    if(/(fl studio|ableton|logic|cubase|pro tools|studio one|reaper|bitwig|garageband|sidechain|warp|how do i|how to)/.test(lower)){
      await send([section('🎹 Looking that up...'),ctx('⏳')],'Searching');
      const[tav,ai]=await Promise.all([tavilySearch(`${text} tutorial step by step`),askAI(`Expert DAW instructor. Answer: "${text}". Numbered steps. Bold key terms.`)]);
      const bl=[header('🎹 DAW Help'),section('🤖 *AI Answer:*'),section(ai||'Error')];
      if(tav?.answer) bl.push(divider(),section('🌐 *From the Web:*'),section(tav.answer));
      if(tav?.results?.length) bl.push(divider(),section('📚 *Resources:*'),section(tav.results.slice(0,3).map(r=>`• <${r.url}|${r.title}>`).join('\n')));
      await send(bl,'DAW help'); return;
    }

    // ── CHORDS / IDEAS / BPM ──
    if(/chord|progression/.test(lower)){const r=await askAI(`Music theory. "${text}". Chord names, Roman numerals, feel.`);await send([header('🎹 Chords'),section(r||'Error')],'Chords');return;}
    if(/idea|concept|what should i make|suggest/.test(lower)){const r=await askAI(`Creative producer. "${text}". 3-5 track ideas with BPM, key, concept.`);await send([header('🎵 Ideas'),section(r||'Error')],'Ideas');return;}
    if(/\bbpm\b|tempo/.test(lower)){const r=await askAI(`Production expert. "${text}". Specific numbers.`);await send([header('🥁 BPM & Key'),section(r||'Error')],'BPM');return;}

    // ── FALLBACK ──
    const r=await askAI(`You are Wavmind, expert AI for music producers. Answer: "${text}"`);
    await send([section(r||'Try asking differently.'),ctx('Type `help` for the menu')],'Wavmind'); return;
  }

  // Channel monitoring
  const kws=['muddy','808','sidechain','compress','reverb','mixing','mastering','plugin','vst','fl studio','ableton','logic pro','melody','chord','bass line','hi-hat','kick','snare','bpm'];
  if(kws.some(k=>lower.includes(k))&&!lower.startsWith('/')&&Math.random()<0.33){
    try{
      const r=await askAI(`Producer said: "${text}". 2-sentence tip + one suggestion. Conversational.`);
      if(r) await say({thread_ts:message.ts,text:'Tip',blocks:[section(`🎛️ *Wavmind:* ${r}`),ctx('DM me to chat')]});
    }catch(e){console.error('Monitor:',e.message);}
  }
});

// ─── APP MENTION ──────────────────────────────────────────
app.event('app_mention',async({event,say})=>{
  const input=event.text.replace(/<@[^>]+>/g,'').trim();
  const send=async(bl,t)=>say({blocks:bl,text:t||'Wavmind'});
  if(!input){await send(getWelcomeBlocks(),'Welcome');return;}
  if(/(sample|drum|piano|bass|guitar|synth)/.test(input.toLowerCase())){
    const q=input.replace(/find|search|get|me|some/gi,'').trim();
    await send(await buildSamplesBlocks(q,event.user),'Samples'); return;
  }
  if(/feedback|mix/.test(input.toLowerCase())){await handleFeedback(event.user,send);return;}
  const r=await askAI(`You are Wavmind, expert AI for music producers. Answer: "${input}"`);
  await say({text:'Wavmind',blocks:[section(`<@${event.user}>`),section(r||'Error'),ctx('DM me to chat')]});
});

// ─── FILE UPLOAD ──────────────────────────────────────────
app.event('file_shared',async({event,client})=>{
  try{
    const fi=await client.files.info({file:event.file_id});
    const file=fi.file;
    const ext=file.name.split('.').pop().toLowerCase();
    if(!['mp3','wav','flac','aac','m4a','ogg'].includes(ext)) return;
    const uid=event.user_id;
    const chid=event.channel_id;
    const post=(bl,t)=>client.chat.postMessage({channel:chid,text:t||'Wavmind',blocks:bl});
    const cs=uid?getCompare(uid):null;

    if(cs){
      if(cs.status==='waiting_your_track'){
        await post([header('🎵 Scanning Your Track...'),section(`*${file.name}*`),ctx('⏳ Step 1 of 2')],'Scanning');
        const a=await analyzeAudio(file.url_private_download,file.name);
        if(!a||a.error){await post([header('❗ Scan Failed'),section('Try an MP3 under ~15MB.')],'Error');return;}
        cs.yourTrack={filename:file.name,...a};
        cs.status='waiting_reference';
        const hasFull=a.lufs!==undefined;
        const bl=[header('✅ Your Track — Step 1 of 2'),section(`*${file.name}*`),divider()];
        if(hasFull){bl.push(twoCol(`🔊 *Loudness*\n${a.lufs} LUFS`,`🎚️ *Stereo*\n${a.stereo_width}%`));bl.push(twoCol(`📊 *L/M/H*\n${a.low_pct}/${a.mid_pct}/${a.high_pct}%`,`⚡ *Energy*\n${a.energy}%`));}
        else{bl.push(twoCol(`⚡ *Energy*\n${scoreBar(a.energy)}`,`🔊 *Bass*\n${a.bass_ratio}%`));}
        bl.push(divider(),header('🎯 Step 2 — Upload Your Reference Track'),section('Upload the song you want to sound like.'));
        await post(bl,'Track scanned');
      } else if(cs.status==='waiting_reference'){
        await post([header('🔍 Scanning Reference...'),section(`*${file.name}*`),ctx('⏳ Generating comparison...')],'Scanning');
        const a=await analyzeAudio(file.url_private_download,file.name);
        if(!a||a.error){await post([header('❗ Scan Failed'),section('Try an MP3 under ~15MB.')],'Error');return;}
        cs.referenceTrack={filename:file.name,...a};
        const y=cs.yourTrack,r=cs.referenceTrack;
        clearCompare(uid);
        const hasFull=y.lufs!==undefined&&r.lufs!==undefined;
        const gap=(mine,ref,unit,within)=>{const diff=+(ref-mine).toFixed(1);const st=Math.abs(diff)<=within?'✅ Match':diff>0?'🔴 Ref higher':'🟢 Yours higher';return `${mine}${unit} → ${ref}${unit}  ${st}`;};
        const aiPrompt=hasFull?`Professional mastering engineer. Compare and give specific fixes (EQ in Hz, compression, real plugin names).

MINE "${y.filename}": loudness ${y.lufs} LUFS, stereo ${y.stereo_width}%, low/mid/high ${y.low_pct}/${y.mid_pct}/${y.high_pct}%, brightness ${y.spectral_centroid}Hz, energy ${y.energy}%
REFERENCE "${r.filename}": loudness ${r.lufs} LUFS, stereo ${r.stereo_width}%, low/mid/high ${r.low_pct}/${r.mid_pct}/${r.high_pct}%, brightness ${r.spectral_centroid}Hz, energy ${r.energy}%

Cover: 1) Loudness 2) Spectral balance / lows/mids/highs 3) Stereo width 4) Energy. Then "Top 3 moves to match the reference".`
        :`Professional mixing engineer. Compare:
YOUR "${y.filename}": energy ${y.energy}%, brightness ${y.brightness}, bass ${y.bass_ratio}%
REFERENCE "${r.filename}": energy ${r.energy}%, brightness ${r.brightness}, bass ${r.bass_ratio}%
Give specific EQ, compression fixes. Top 3 changes. Real plugin names.`;
        const ai=await askAI(aiPrompt);
        const bl=[header('🆚 Mix Comparison Report'),twoCol(`🎵 *Yours*\n${y.filename}`,`🎯 *Reference*\n${r.filename}`),divider(),section('*📊 Measured Differences*')];
        if(hasFull){
          bl.push(section([`🔊 *Loudness* — ${gap(y.lufs,r.lufs,' LUFS',1.5)}`,`🎚️ *Stereo Width* — ${gap(y.stereo_width,r.stereo_width,'%',8)}`,`🟥 *Lows* — ${gap(y.low_pct,r.low_pct,'%',5)}`,`🟩 *Mids* — ${gap(y.mid_pct,r.mid_pct,'%',5)}`,`🟦 *Highs* — ${gap(y.high_pct,r.high_pct,'%',5)}`,`⚡ *Energy* — ${gap(y.energy,r.energy,'%',6)}`].join('\n')));
        } else {
          const ediff=r.energy-y.energy,bdiff=r.bass_ratio-y.bass_ratio;
          bl.push(section([`⚡ *Energy*: ${y.energy}% → ${r.energy}%  ${Math.abs(ediff)<=5?'✅ Match':ediff>0?'🔴 Ref higher':'🟢 Yours higher'}`,`🔊 *Bass*: ${y.bass_ratio}% → ${r.bass_ratio}%  ${Math.abs(bdiff)<=5?'✅ Match':bdiff>0?'🔴 Ref heavier':'🟢 Yours heavier'}`].join('\n')));
        }
        bl.push(divider(),header('🤖 How to Match the Reference'),section(ai||'Could not generate.'),divider(),actions([btn('🆚 Compare Again','quick_compare','primary')]));
        await post(bl,'Comparison ready');
      }
      return;
    }

    // Normal upload
    await post([header('🎵 Scanning Your Track...'),section(`*${file.name}*`),ctx('⏳ Deep analysis: loudness, stereo, spectral...')],'Scanning');
    const a=await analyzeAudio(file.url_private_download,file.name);
    if(!a||a.error){await post([header('❗ Scan Failed'),section('Try an MP3 under ~15MB.')],'Error');return;}
    if(uid) trackUpload(uid,file.name,a);
    global.pendingAnalysis[chid]={filename:file.name,...a};
    const hasFull=a.lufs!==undefined;
    const bl=[header('🎛️ Scan Complete'),section(`*${file.name}*`),divider()];
    if(hasFull){
      bl.push(twoCol(`🔊 *Loudness*\n${loudnessVerdict(a.lufs)}`,`🎚️ *Stereo Width*\n${a.stereo_width}%`));
      bl.push(twoCol(`📊 *Low / Mid / High*\n${a.low_pct}% / ${a.mid_pct}% / ${a.high_pct}%`,`🎤 *Vocal Clarity*\n${a.vocal_clarity}%`));
      bl.push(twoCol(`⚡ *Energy*\n${scoreBar(a.energy)}`,`🌈 *Brightness*\n${a.brightness}`));
    } else {
      const mins=Math.floor(a.duration/60),secs=String(a.duration%60).padStart(2,'0');
      bl.push(twoCol(`⚡ *Energy*\n${scoreBar(a.energy)}`,`🌈 *Brightness*\n${a.brightness}`));
      bl.push(twoCol(`🔊 *Bass*\n${a.bass_ratio}%`,`⏱️ *Duration*\n${mins}:${secs}`));
      const issues=[];
      if(a.energy<50) issues.push('⚠️ Low energy — mix lacks punch');
      if(a.bass_ratio>65) issues.push('⚠️ Heavy bass — muddy on small speakers');
      if(a.bass_ratio<20) issues.push('⚠️ Thin bass — needs more low end');
      if(issues.length) bl.push(divider(),section(`*Quick insights:*\n${issues.join('\n')}`));
    }
    bl.push(divider(),section('*What next?*'),actions([btn('🎚️ Get Feedback','quick_feedback','primary'),btn('🆚 Compare with Reference','quick_compare')]),ctx('🤖 I\'ll DM you a follow-up reminder tomorrow'));
    await post(bl,'Scan complete');
    if(uid){try{await publishHome(client,uid);}catch(e){}}
  }catch(e){console.error('File:',e.message);}
});

// ─── RELEASES HELPER ──────────────────────────────────────
async function sendReleases(uid,send){
  const p=getPrefs(uid);
  await send([section(`🔍 Finding latest *${p.genre}* releases...`),ctx('⏳')],'Searching');
  const releases=await getNewReleases(p.genre);
  if(!releases?.length){await send([header('🎵 No Releases Found'),section(`Couldn't find recent *${p.genre}* drops. Try a broader genre.`)],'No results');return;}
  const lines=releases.map(r=>`• *<${r.url}|${r.name}>* — ${r.artist} _(${r.date})_`).join('\n');
  await send([header(`🎵 Latest ${p.genre} Releases`),section(lines),divider(),ctx('🤖 Daily drops · DM me "set genre [x]" to change')],'Releases');
}

// ─── SCHEDULER ────────────────────────────────────────────
function startScheduler(client){

  // 24hr upload reminders
  const checkReminders=async()=>{
    try{
      const now=new Date(); let changed=false;
      for(const uid of Object.keys(global.pendingReminders)){
        for(const rem of global.pendingReminders[uid]){
          if(rem.sent||new Date(rem.remindAt)>now) continue;
          rem.sent=true; changed=true;
          console.log(`📬 Reminder → ${uid} "${rem.filename}"`);
          await client.chat.postMessage({channel:uid,text:'Wavmind check-in',blocks:[
            header('🎛️ Wavmind Check-in'),
            section(`You uploaded *"${rem.filename}"* yesterday.\nWant fresh feedback or to compare it?`),
            actions([btn('🎚️ Get Feedback','quick_feedback','primary'),btn('🆚 Compare','quick_compare')]),
          ]});
        }
      }
      if(changed) saveR();
    }catch(e){console.error('Reminders:',e.message);}
  };

  // Daily project reminders
  const checkProjects=async()=>{
    try{
      const today=todayStr();
      for(const uid of Object.keys(global.userProjects)){
        for(const proj of global.userProjects[uid]||[]){
          if(proj.completed||proj.lastDailyReminder===today) continue;
          const lines=[];
          for(const k of SESSION_KEYS){
            const s=proj.sessions[k];
            if(s.done||!s.deadline) continue;
            const days=daysUntil(s.deadline);
            if(days<=7) lines.push(`${deadlineEmoji(days)} *${sessionLabel(k)}* — ${daysPhrase(days)}`);
          }
          if(!lines.length) continue;
          proj.lastDailyReminder=today; saveP();
          const tip=await askAI(`Producer's session is coming up soon for "${proj.name}". One short motivating tip under 25 words.`);
          console.log(`📅 Project reminder → ${uid} "${proj.name}"`);
          await client.chat.postMessage({channel:uid,text:'Project reminder',blocks:[
            header(`📋 ${proj.name} — Daily Check-in`),
            section(`Here's what's coming up:\n${lines.join('\n')}`),
            divider(),
            section(`🤖 ${tip||'Keep the momentum going!'}`),
            ctx('Mark done: "done mixing" · View: "show project"'),
          ]});
        }
      }
    }catch(e){console.error('Projects:',e.message);}
  };

  // Daily new releases
  const checkReleases=async()=>{
    try{
      const today=todayStr();
      for(const uid of Object.keys(global.userPrefs)){
        const p=global.userPrefs[uid];
        if(!p?.releases||!p.genre||p.lastRelease===today) continue;
        const releases=await getNewReleases(p.genre,5);
        if(!releases?.length) continue;
        p.lastRelease=today; savePr();
        const lines=releases.map(r=>`• *<${r.url}|${r.name}>* — ${r.artist} _(${r.date})_`).join('\n');
        await client.chat.postMessage({channel:uid,text:'New releases',blocks:[header(`🎵 New ${p.genre} Releases`),section(lines),ctx('🤖 Daily drops · DM "set genre [x]" to change')]});
      }
    }catch(e){console.error('Releases:',e.message);}
  };

  // Daily DAW lessons
  const checkLessons=async()=>{
    try{
      const today=todayStr();
      for(const uid of Object.keys(global.userPrefs)){
        const p=global.userPrefs[uid];
        if(!p?.dawLessons||!p.daw||p.lastLesson===today) continue;
        p.lastLesson=today; savePr();
        const lesson=await askAI(`Daily micro-lesson for a ${p.skillLevel||'beginner'} ${p.daw} producer. One specific technique, 3-4 steps, varied topic, under 130 words.`);
        await client.chat.postMessage({channel:uid,text:'DAW lesson',blocks:[header(`🎓 Today's ${p.daw} Lesson`),section(lesson||'Lesson unavailable today.'),ctx(`Level: ${p.skillLevel} · DM "stop lessons" to pause`)]});
      }
    }catch(e){console.error('Lessons:',e.message);}
  };

  // Weekly digest
  const sendDigest=async()=>{
    try{
      for(const uid of Object.keys(global.weeklyStats)){
        const stats=global.weeklyStats[uid];
        if(!stats||stats.tracks===0) continue;
        const top=stats.issues.sort((a,b)=>stats.issues.filter(i=>i===b).length-stats.issues.filter(i=>i===a).length)[0]||'None';
        const tip=await askAI(`Producer analyzed ${stats.tracks} tracks. Top issue: ${top}. One specific tip. Under 50 words.`);
        const projs=getProjects(uid);
        await client.chat.postMessage({channel:uid,text:'Weekly report',blocks:[
          header('📊 Your Weekly Report'),
          section(`*Week of ${new Date().toLocaleDateString()}*`),
          divider(),
          twoCol(`🎵 *Tracks Scanned*\n${stats.tracks}`,`⚠️ *Top Issue*\n${top}`),
          twoCol(`📋 *Active Projects*\n${projs.filter(p=>!p.completed).length}`,`✅ *Completed*\n${projs.filter(p=>p.completed).length}`),
          divider(),
          section(`*🤖 This week's tip:*\n${tip||'Keep producing!'}`),
          ctx('📊 Automated weekly report · Every Monday 9am · Wavmind'),
        ]});
        global.weeklyStats[uid]={tracks:0,issues:[]};
        saveS();
      }
    }catch(e){console.error('Digest:',e.message);}
  };

  checkReminders(); setInterval(checkReminders,5*60*1000);
  checkProjects();  setInterval(checkProjects,60*60*1000);
  checkReleases();  setInterval(checkReleases,6*60*60*1000);
  checkLessons();   setInterval(checkLessons,6*60*60*1000);

  const now=new Date(),nm=new Date();
  nm.setDate(now.getDate()+((1+7-now.getDay())%7||7));
  nm.setHours(9,0,0,0);
  setTimeout(()=>{sendDigest();setInterval(sendDigest,7*24*3600*1000);},nm-now);

  console.log('⏰ Scheduler: reminders/5min · projects/1hr · releases+lessons/6hr · digest Monday 9am');
}

// ─── MCP SERVER ───────────────────────────────────────────
function startMCPServer(){
  const tools=[
    {name:'search_samples',description:'Search 500K+ free Creative Commons samples from Freesound'},
    {name:'get_track_features',description:'Get real Spotify audio features for any track'},
    {name:'analyze_mix',description:'Get AI mixing feedback from description'},
    {name:'get_daw_help',description:'DAW tutorials via Tavily + AI'},
    {name:'compare_artists',description:'Compare two artists via Spotify data'},
    {name:'new_releases',description:'Get latest releases for a genre from Spotify'},
  ];
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Content-Type');
    if(req.method==='OPTIONS'){res.writeHead(200);res.end();return;}
    let body='';
    req.on('data',c=>body+=c);
    req.on('end',async()=>{
      try{
        if(req.url==='/health'){res.writeHead(200);res.end(JSON.stringify({status:'ok',service:'Wavmind AI Producer Agent',version:'2.0.0',tools:tools.map(t=>t.name)}));return;}
        if(req.url==='/mcp'){res.writeHead(200);res.end(JSON.stringify({name:'wavmind',version:'2.0.0',description:'AI tools for music producers',tools}));return;}
        if(req.url==='/mcp/tools'){res.writeHead(200);res.end(JSON.stringify({tools}));return;}
        if(req.method==='POST'&&req.url==='/mcp/execute'){
          const{tool,arguments:args}=JSON.parse(body);
          let result;
          switch(tool){
            case 'search_samples': result=await searchFreesound(args.query);break;
            case 'get_track_features': result=await getTrackFeatures(args.track_name);break;
            case 'analyze_mix': result=await askAI(`Mix feedback: ${args.description}`);break;
            case 'get_daw_help':{const[t,a]=await Promise.all([tavilySearch(`${args.daw} ${args.question}`),askAI(`${args.daw} tutorial: "${args.question}"`)]);result={ai_answer:a,web_answer:t?.answer};break;}
            case 'compare_artists':{const[s1,s2]=await Promise.all([getArtistStats(args.artist1),getArtistStats(args.artist2)]);result={artist1:s1,artist2:s2};break;}
            case 'new_releases': result=await getNewReleases(args.genre);break;
            default: result={error:`Unknown tool: ${tool}`};
          }
          res.writeHead(200);res.end(JSON.stringify({tool,result}));return;
        }
        res.writeHead(404);res.end(JSON.stringify({error:'Not found'}));
      }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
    });
  });
  const port=process.env.PORT||8000;
  server.listen(port,()=>console.log(`🔌 MCP Server on port ${port}`));
}

// ─── SLASH COMMANDS ───────────────────────────────────────
app.command('/wavmind',async({command,ack,respond,client})=>{
  await ack();
  const input=command.text.trim();
  const lower=input.toLowerCase();
  const uid=command.user_id;
  const send=async(bl,t)=>respond({blocks:bl,text:t||'Wavmind'});

  if(!input||lower==='help'||lower==='menu'){await send(getWelcomeBlocks(),'Welcome');return;}

  // project
  if(/^(start|new)\s*project/.test(lower)){
    const name=input.replace(/^(start|new)\s*project/i,'').trim();
    if(name){const p=createProject(uid,name);await send([header(`📋 ${p.name} — Created!`),section(scoreBar(0)),divider(),section('Set deadlines:\nrecording 12/06/2026 · mixing 15/06/2026 · mastering 18/06/2026\nartwork 20/06/2026 · release 25/06/2026 · promotion 28/06/2026')],'Created');await publishHome(client,uid);}
    else{global.userFlow[uid]={state:'awaiting_project_name'};await send([header('📋 New Project'),section('DM me the project name.')],'Name');}
    return;
  }
  if(lower==='project'||lower==='show project'){
    const p=getActiveProject(uid);
    await send(p?buildProjectBlocks(p):[header('📋 No Active Project'),section('Type `/wavmind start project My EP`')],'Project'); return;
  }
  const dl=lower.match(/^(recording|mixing|mastering|artwork|release|promotion)\s+(.+)$/);
  if(dl){
    const proj=getActiveProject(uid);
    if(!proj){await send([header('❗ No Active Project'),section('Type `/wavmind start project My EP`')],'No project');return;}
    const parsed=parseDate(dl[2]);
    if(!parsed){await send([header('❗ Bad date'),section(`Try: ${dl[1]} 12/06/2026`)],'Bad date');return;}
    setDeadline(uid,dl[1],parsed.toISOString());
    const days=daysUntil(parsed.toISOString());
    await send([header(`📅 ${sessionLabel(dl[1])} deadline set`),section(`*${parsed.toLocaleDateString()}* — ${deadlineEmoji(days)} ${daysPhrase(days)}`),divider(),section(projectSessionsText(getActiveProject(uid)))],'Set');
    await publishHome(client,uid); return;
  }
  const doneM=lower.match(/^done\s+(recording|mixing|mastering|artwork|release|promotion)$/);
  if(doneM){
    const proj=getActiveProject(uid);if(!proj){await send([header('❗ No Active Project')],'No project');return;}
    markDone(uid,doneM[1]);
    const h=projectHealth(getActiveProject(uid));
    await send([header(`✅ ${sessionLabel(doneM[1])} done!`),section(`${scoreBar(h.pct)}\n${h.done}/${h.total} sessions`)],'Done');
    await publishHome(client,uid); return;
  }
  if(lower==='complete project'){
    const proj=getActiveProject(uid);if(!proj){await send([header('❗ No Active Project')],'No project');return;}
    completeProject(uid);await send([header('🎉 Project Complete!'),section(`*${proj.name}* is done! 🚀`)],'Complete');await publishHome(client,uid); return;
  }

  // compare
  if(lower==='compare'){
    startCompare(uid);
    await send([header('🆚 Comparison Started'),section('Upload your track, then your reference.\nI compare loudness, stereo, spectral balance & frequency automatically.'),ctx('Type `/wavmind cancel` to stop')],'Compare'); return;
  }
  if(lower==='cancel'){clearCompare(uid);await send([header('🗑️ Cancelled')],'Cancelled');return;}

  // feedback
  if(lower==='feedback'||lower.startsWith('feedback ')){
    if(lower==='feedback'){await handleFeedback(uid,send);return;}
    const desc=input.slice(8).trim();
    await send([header('🎚️ Analyzing...'),section(`_"${desc}"_`),ctx('⏳')],'Analyzing');
    const r=await askAI(`Professional mixing feedback for: "${desc}". EQ, compression, stereo width. Sections with emojis.`);
    await send([header('🎚️ Mix Feedback'),section(`_${desc}_`),divider(),section(r||'Error')],'Feedback'); return;
  }

  // samples
  if(lower.startsWith('sample')){
    const q=input.replace(/^samples?\s*/i,'').trim();
    if(!q){await send([header('🎵 Free Samples'),section('Type: `/wavmind samples drums`\n/wavmind samples piano · bass · synth · strings · vocal'),ctx('500K+ CC sounds')],'Samples');return;}
    await send(await buildSamplesBlocks(q,uid),'Samples'); return;
  }

  // reference
  if(lower.startsWith('reference')){
    const q=input.slice(9).trim();
    if(!q){await send([header('🔍 Reference'),section('Type: `/wavmind reference Tum Hi Ho - Arijit Singh`')],'Reference');return;}
    await send([header('🔍 Looking up...'),section(`*${q}*`),ctx('⏳')],'Searching');
    const f=await getTrackFeatures(q);
    if(f){
      const r=await askAI(`How to achieve sound of ${f.name} by ${f.artist}: BPM ${f.bpm}, Key ${f.key}, Energy ${f.energy}%, Loudness ${f.loudness}dB. Techniques + real plugins.`);
      await send([header('🎵 Reference Analysis'),section(`*${f.name}* by *${f.artist}*`),twoCol(`🥁 *BPM*\n${f.bpm}`,`🎵 *Key*\n${f.key}`),twoCol(`⚡ *Energy*\n${scoreBar(f.energy)}`,`🔊 *Loudness*\n${f.loudness} dB`),divider(),section(r||'Error')],'Reference');
    } else {
      const r=await askAI(`Blueprint for "${q}". Tempo, key, drums, bass, melody, mix approach.`);
      await send([header('🎵 Reference'),section(`*${q}*`),divider(),section(r||'Error')],'Reference');
    }
    return;
  }

  // releases
  if(lower.startsWith('release')||lower==='releases'){
    if(lower.startsWith('set genre')){const g=input.replace(/^set genre/i,'').trim();if(g){const p=getPrefs(uid);p.genre=g;p.releases=true;p.lastRelease=null;savePr();await send([header('🎵 Genre set ✅'),section(`Tracking *${g}*`)],'Set');return;}}
    const p=getPrefs(uid);
    if(!p.genre){await send([header('🎵 New Releases'),section('Set genre first: `/wavmind set genre trap`')],'No genre');return;}
    await sendReleases(uid,send); return;
  }
  if(lower.startsWith('set genre')){
    const g=input.replace(/^set genre/i,'').trim();
    if(g){const p=getPrefs(uid);p.genre=g;p.releases=true;p.lastRelease=null;savePr();await send([header('🎵 Genre set ✅'),section(`Tracking *${g}*. Type \`/wavmind releases\` to see drops now.`)],'Set');}
    return;
  }

  // artist
  if(lower.startsWith('artist')){
    const artists=input.slice(6).trim();
    if(!artists){await send([header('🎤 Artist Comparison'),section('Type: `/wavmind artist Drake and Travis Scott`')],'Artists');return;}
    await send([header('🔍 Comparing...'),ctx('⏳')],'Comparing');
    let a1,a2;
    if(/\sand\s/i.test(artists))[a1,a2]=artists.split(/\s+and\s+/i);
    else if(/\svs\s/i.test(artists))[a1,a2]=artists.split(/\s+vs\s+/i);
    else{const w=artists.split(' ');const m=Math.ceil(w.length/2);a1=w.slice(0,m).join(' ');a2=w.slice(m).join(' ');}
    const[s1,s2]=await Promise.all([getArtistStats(a1.trim()),getArtistStats(a2.trim())]);
    if(!s1||!s2){await send([header('❗ Not Found'),section('Try: `/wavmind artist Drake and Travis Scott`')],'Not found');return;}
    const ai=await askAI(`Compare ${s1.name} (BPM ${s1.bpm}, Energy ${s1.energy}%) vs ${s2.name} (BPM ${s2.bpm}, Energy ${s2.energy}%). Key differences + how to blend.`);
    await send([header('🎤 Artist Comparison'),twoCol(`*${s1.name}*\n🥁 ${s1.bpm} BPM · ⚡ ${s1.energy}%\n🔊 ${s1.loudness}dB · 🎵 ${s1.key}`,`*${s2.name}*\n🥁 ${s2.bpm} BPM · ⚡ ${s2.energy}%\n🔊 ${s2.loudness}dB · 🎵 ${s2.key}`),divider(),section(ai||'Error')],'Artists');
    return;
  }

  // daw
  if(lower.startsWith('daw')){
    const q=input.slice(3).trim();
    if(!q){await send([header('🎹 DAW Help'),section('Type: `/wavmind daw fl studio sidechain 808`\n\nFor daily lessons, DM me "teach me fl studio"')],'DAW');return;}
    await send([header(`🎹 Looking up...`),section(`*${q}*`),ctx('⏳')],'Searching');
    const[tav,ai]=await Promise.all([tavilySearch(`${q} tutorial step by step`),askAI(`Expert DAW instructor. Answer: "${q}". Numbered steps.`)]);
    const bl=[header('🎹 DAW Help'),section(ai||'Error')];
    if(tav?.answer) bl.push(divider(),section('🌐 *From the Web:*'),section(tav.answer));
    if(tav?.results?.length) bl.push(divider(),section('📚 *Resources:*'),section(tav.results.slice(0,4).map(r=>`• <${r.url}|${r.title}>`).join('\n')));
    await send(bl,'DAW help'); return;
  }

  // production tools
  if(lower.startsWith('ideas')){const g=input.slice(5).trim()||'general';const r=await askAI(`5 track ideas for "${g}". 🎵 *Title* — concept.`);await send([header('🎵 Track Ideas'),section(r||'Error')],'Ideas');return;}
  if(lower.startsWith('chords')){const q=input.slice(6).trim()||'C minor';const r=await askAI(`3 chord progressions for "${q}". Chords, Roman numerals, feel.`);await send([header('🎹 Chords'),section(r||'Error')],'Chords');return;}
  if(lower.startsWith('bpm')){const q=input.slice(3).trim()||'general';const r=await askAI(`For "${q}": ideal BPM, keys, chord progressions. Specific numbers.`);await send([header('🥁 BPM & Key'),section(r||'Error')],'BPM');return;}
  if(lower.startsWith('tips')){const q=input.slice(4).trim()||'music production';const r=await askAI(`5 professional tips about "${q}". Real techniques and plugin names.`);await send([header('💡 Tips'),section(r||'Error')],'Tips');return;}
  if(lower==='mcp'){const base=`https://${process.env.RAILWAY_PUBLIC_DOMAIN||'your-url.railway.app'}`;await send([header('🔌 MCP Server'),section(`${base}/health\n${base}/mcp/tools\n${base}/mcp/execute (POST)`),ctx('Compatible with Claude, GPT & any MCP client')],'MCP');return;}

  // test commands
  if(lower==='test reminder'){
    const ul=global.userUploads[uid]||[];const last=ul[ul.length-1];
    if(!last){await send([header('❗ Upload a track first')],'No track');return;}
    if(!global.pendingReminders[uid]) global.pendingReminders[uid]=[];
    global.pendingReminders[uid].push({filename:last.filename,analysis:last.analysis,uploadedAt:new Date().toISOString(),remindAt:new Date(Date.now()+10000).toISOString(),sent:false});
    saveR();await send([header('⏰ Test Reminder Set'),section(`DM in 10 seconds for "${last.filename}"`)],'Set');return;
  }

  // general
  const r=await askAI(`You are Wavmind, expert AI for music producers. Answer: "${input}"`);
  await send([header('🎛️ Wavmind'),section(r||'Error'),ctx('Type `/wavmind` for all features')],'Wavmind');
});

// ─── START ────────────────────────────────────────────────
(async()=>{
  await app.start();
  console.log('🎛️ Wavmind is running!');
  startMCPServer();
  startScheduler(app.client);
})();
