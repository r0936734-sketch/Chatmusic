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
  { name: 'updateSettings', description: 'Only if the user asks to rename the player or change colors.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, bg: { type: 'string' }, fg: { type: 'string' }, accent: { type: 'string' }, css: { type: 'string' }, modules: { type: 'object', properties: { queue: { type: 'boolean' }, cover: { type: 'boolean' } }, additionalProperties: false } }, additionalProperties: false } },
];

const str = (v, n) => typeof v === 'string' && !!v.trim() && v.length <= n;
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function pickVersion(v) {
  const known = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
  if (known.includes(v)) return v;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return '2025-06-18';
}

async function tool(name, a) {
  a = a && typeof a === 'object' ? a : {};
  if (name === 'playSong' || name === 'queueSong') {
    if (!str(a.query, 200)) throw new Error('query must be a non-empty string (max 200 chars)');
    const t = track(a.query);
    const s = await load();
    if (name === 'playSong') { s.now = t; s.seq++; } else s.queue.push(t);
    await save(s);
    return { ok: true, track: t };
  }
  if (name === 'control') {
    if (a.action !== 'pause' && a.action !== 'resume') throw new Error('action must be "pause" or "resume"');
    const s = await load();
    s.cmd = { id: Date.now(), a: a.action };
    await save(s);
    return { ok: true };
  }
  if (name === 'skip') {
    const s = await load();
    if (s.queue.length) { s.now = s.queue.shift(); s.seq++; await save(s); }
    return { ok: true, now: s.now };
  }
  if (name === 'getState') return load();
  if (name === 'updateSettings') {
    const o = {};
    for (const k of ['title', 'bg', 'fg', 'accent']) if (a[k] !== undefined) { if (!str(a[k], 200)) throw new Error(k + ' must be a short string'); o[k] = a[k]; }
    if (a.css !== undefined) { if (typeof a.css !== 'string' || a.css.length > 10000) throw new Error('css must be a string under 10000 chars'); o.css = a.css; }
    if (a.modules !== undefined) {
      if (!a.modules || typeof a.modules !== 'object') throw new Error('modules must be an object');
      o.modules = {};
      for (const k of ['queue', 'cover']) if (a.modules[k] !== undefined) { if (typeof a.modules[k] !== 'boolean') throw new Error('modules.' + k + ' must be boolean'); o.modules[k] = a.modules[k]; }
    }
    if (!Object.keys(o).length) throw new Error('no supported settings provided');
    const s = await load();
    const { modules, ...rest } = o;
    s.settings = { ...s.settings, ...rest, modules: { ...s.settings.modules, ...(modules || {}) } };
    await save(s);
    return { ok: true, settings: s.settings };
  }
  return null;
}

async function handleMsg(m) {
  if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') return rpcErr(m && m.id, -32600, 'Invalid Request');
  if (typeof m.method !== 'string') return null;
  if (m.id === undefined || m.id === null) return null;
  const p = m.params || {};
  if (m.method === 'initialize') {
    return { jsonrpc: '2.0', id: m.id, result: { protocolVersion: pickVersion(p.protocolVersion), capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'sun-suna', version: '1.3.0' }, instructions: INSTRUCTIONS } };
  }
  if (m.method === 'ping') return { jsonrpc: '2.0', id: m.id, result: {} };
  if (m.method === 'tools/list') return { jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } };
  if (m.method === 'tools/call') {
    if (!TOOLS.some((t) => t.name === p.name)) return rpcErr(m.id, -32602, 'Unknown tool: ' + String(p.name).slice(0, 50));
    try {
      const data = await tool(p.name, p.arguments);
      return { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false } };
    } catch (e) {
      return { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: e.message || 'tool failed' }], isError: true } };
    }
  }
  return rpcErr(m.id, -32601, 'Method not found');
}

function send(res, status, data, extra) {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  for (const k in extra || {}) res.setHeader(k, extra[k]);
  if (data === undefined) return res.end();
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

async function mcp(req, res, bridgeKey) {
  const expect = E.BRIDGE_API_KEY || '';
  if (!expect) return send(res, 503, { error: 'Set BRIDGE_API_KEY on Vercel' });
  if (!bridgeKey || !same(bridgeKey, expect)) return send(res, 401, { error: 'Unauthorized' });
  if (req.method === 'GET') return send(res, 200, { ok: true, name: 'sun-suna', tools: TOOLS.map((t) => t.name) });
  if (req.method === 'OPTIONS') return send(res, 204, undefined, { Allow: 'POST, GET, OPTIONS' });
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' }, { Allow: 'POST, GET, OPTIONS' });
  let body;
  try {
    body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    if (Buffer.isBuffer(body)) body = JSON.parse(body.toString('utf8'));
  } catch (e) { return send(res, 400, rpcErr(null, -32700, 'Parse error')); }
  if (!body || typeof body !== 'object') return send(res, 400, rpcErr(null, -32700, 'Parse error'));
  if (Array.isArray(body)) {
    if (!body.length) return send(res, 400, rpcErr(null, -32600, 'Invalid Request'));
    const out = (await Promise.all(body.map(handleMsg))).filter(Boolean);
    return out.length ? send(res, 200, out) : send(res, 202);
  }
  const out = await handleMsg(body);
  return out ? send(res, out.error && out.error.code === -32600 ? 400 : 200, out) : send(res, 202);
}

module.exports = async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const p = u.searchParams.get('p') || '';
    const b = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
    if (p === 'mcp') return mcp(req, res, u.searchParams.get('k') || u.searchParams.get('key') || '');
    const out = (o, c) => { res.status(c || 200).json(o); };
    if (p === '') { res.setHeader('content-type', 'text/html'); return res.status(200).send(HTML); }
    const s = await load();
    if (p === 'state') return out(s);
    if (p === 'next') {
      if (b.seq !== undefined && Number(b.seq) !== s.seq) return out({ ok: true });
      if (s.queue.length) { s.now = s.queue.shift(); s.seq++; await save(s); }
      return out({ ok: true, now: s.now });
    }
    const ok = req.headers['x-api-key'] === E.API_KEY && !!E.API_KEY;
    if (!ok) return out({ error: 'bad api key' }, 401);
    if (p === 'play' || p === 'queue') {
      const t = track(b.query || '');
      if (!t) return out({ error: 'query required' }, 400);
      if (p === 'play') { s.now = t; s.seq++; } else s.queue.push(t);
      await save(s); return out({ ok: true, track: t });
    }
    if (p === 'skip') { if (s.queue.length) { s.now = s.queue.shift(); s.seq++; await save(s); } return out({ ok: true, now: s.now }); }
    if (p === 'control') { s.cmd = { id: Date.now(), a: b.action === 'pause' ? 'pause' : 'resume' }; await save(s); return out({ ok: true }); }
    if (p === 'settings') {
      const { modules, ...rest } = b;
      s.settings = { ...s.settings, ...rest, modules: { ...s.settings.modules, ...(modules || {}) } };
      await save(s); return out({ ok: true, settings: s.settings });
    }
    return out({ error: 'not found' }, 404);
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
};
