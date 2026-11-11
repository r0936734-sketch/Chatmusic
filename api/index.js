// One Vercel function: phone state + ChatGPT MCP plugin.
// Audio is resolved on the phone (RapidAPI), not here.
// Env: API_KEY, BRIDGE_API_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
// Plugin URL: https://chatmusic-mocha.vercel.app/api/mcp/BRIDGE_API_KEY
const crypto = require('crypto');
const E = process.env;
const RU = E.UPSTASH_REDIS_REST_URL || E.KV_REST_API_URL;
const RT = E.UPSTASH_REDIS_REST_TOKEN || E.KV_REST_API_TOKEN;
const rd = async (...c) =>
  (await (await fetch(RU, { method: 'POST', headers: { Authorization: 'Bearer ' + RT }, body: JSON.stringify(c) })).json()).result;

const init = () => ({
  seq: 0, now: null, queue: [], cmd: null,
  settings: { title: 'Sun Suna', bg: '#111111', fg: '#ffffff', accent: '#d4af37', css: '', modules: { queue: true, cover: true } },
});
const load = async () => { try { return JSON.parse(await rd('GET', 'st')) || init(); } catch (e) { return init(); } };
const save = (s) => rd('SET', 'st', JSON.stringify(s));

function track(q) {
  const query = String(q || '').trim().slice(0, 200);
  if (!query) return null;
  return { id: 'q-' + Date.now(), title: query, artist: '', url: '', img: '' };
}

const HTML = '<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Sun Suna</title>' +
'<body style="font-family:sans-serif;background:#111;color:#fff;padding:24px;text-align:center">' +
'<h2>Sun Suna</h2><p>ChatGPT sends songs here. Open the Sun Suna app on your phone. It downloads the MP3 and plays it.</p>' +
'<pre id=s style="text-align:left;white-space:pre-wrap"></pre><script>' +
'function poll(){fetch("/api/state").then(function(r){return r.json()}).then(function(s){' +
'document.getElementById("s").textContent=JSON.stringify({seq:s.seq,now:s.now,queue:s.queue,cmd:s.cmd},null,2)})}' +
'poll();setInterval(poll,2000)</script>';

const INSTRUCTIONS = 'You control the user Sun Suna phone. Never invent a stream URL and never ask for a RapidAPI key. ' +
  'To play now, call playSong with query set to "song title artist" only. ' +
  'To play something later, call queueSong the same way. ' +
  'Pause and resume with control, action pause or resume. Skip with skip. ' +
  'If asked what is playing, call getState and answer from now.title. ' +
  'Do not call updateSettings unless asked to rename the player or change colors. ' +
  'After playSong or queueSong succeeds, reply with one short sentence naming the song. ' +
  'If a tool returns an error, say the phone bridge rejected it. Do not pretend it played.';

const qSchema = { type: 'object', properties: { query: { type: 'string', description: 'Only "song title artist". No extra words and no URL.' } }, required: ['query'], additionalProperties: false };
const none = { type: 'object', properties: {}, additionalProperties: false };
const TOOLS = [
  { name: 'playSong', description: 'Play this song now on the Sun Suna phone. The phone searches and downloads the MP3. query is "song title artist" only.', inputSchema: qSchema },
  { name: 'queueSong', description: 'Queue a song on the Sun Suna phone to play after the current one. query is "song title artist" only.', inputSchema: qSchema },
  { name: 'control', description: 'Pause or resume the phone. action must be pause or resume.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['pause', 'resume'] } }, required: ['action'], additionalProperties: false } },
  { name: 'skip', description: 'Skip to the next song queued on the phone.', inputSchema: none },
  { name: 'getState', description: 'Read what the phone is playing and what is queued.', inputSchema: none, annotations: { readOnlyHint: true } },
  { name: 'updateSettings', description: 'Only if the user asks to rename the player or
