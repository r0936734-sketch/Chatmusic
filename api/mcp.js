// MCP plugin endpoint for ChatGPT. Stateless Streamable HTTP.
// ChatGPT calls https://chatmusic-mocha.vercel.app/api/mcp?key=BRIDGE_API_KEY
// This function writes to the mediator on the same host. The phone does RapidAPI.
//
// Env:
//   BRIDGE_API_KEY     secret ChatGPT must present (?key=, Bearer, or x-api-key)
//   API_KEY            mediator write key (same value as on api/index.js)
//   CHAT_MUSIC_API_KEY optional, defaults to API_KEY
//   CHAT_MUSIC_API_BASE optional, default https://chatmusic-mocha.vercel.app
//   CHAT_MUSIC_TIMEOUT_MS optional, default 8000
const crypto = require('crypto');

const E = process.env;
const cfg = () => ({
  base: (E.CHAT_MUSIC_API_BASE || 'https://chatmusic-mocha.vercel.app').replace(/\/+$/, ''),
  upKey: E.CHAT_MUSIC_API_KEY || E.API_KEY || '',
  inKey: E.BRIDGE_API_KEY || '',
  timeout: Number(E.CHAT_MUSIC_TIMEOUT_MS) || 8000,
});

const INSTRUCTIONS = [
  'You control the user\'s Sun Suna phone. You never invent a stream URL and you never ask for a RapidAPI key.',
  'To play now, call playSong with query set to "song title artist" only.',
  'To play something after the current song, call queueSong the same way.',
  'Pause and resume with control, action "pause" or "resume". Skip with skip.',
  'If they ask what is playing, call getState and answer from now.title. Mention now.artist only if it is non-empty.',
  'Do not call updateSettings unless they ask to rename the player or change colors.',
  'After playSong or queueSong succeeds, reply with one short sentence naming the song.',
  'If a tool returns an error, say the phone bridge rejected it. Do not pretend it played.',
].join(' ');

const q = { type: 'object', properties: { query: { type: 'string', description: 'Only "song title artist". No extra words, no URL.' } }, required: ['query'], additionalProperties: false };
const none = { type: 'object', properties: {}, additionalProperties: false };
const TOOLS = [
  { name: 'playSong', description: 'Play this song now on the Sun Suna phone. The phone searches and downloads the MP3. query is "song title artist" only.', inputSchema: q },
  { name: 'queueSong', description: 'Add a song to play after the current one on the Sun Suna phone. query is "song title artist" only.', inputSchema: q },
  { name: 'control', description: 'Pause or resume the phone. action must be pause or resume.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['pause', 'resume'] } }, required: ['action'], additionalProperties: false } },
  { name: 'skip', description: 'Skip to the next song queued on the phone.', inputSchema: none },
  { name: 'getState', description: 'Read what the phone is playing and what is queued. Read only.', inputSchema: none, annotations: { readOnlyHint:
  { name: 'updateSettings', description: 'Optional. Change the player title or colors only when the user asks. Fields: title, bg, fg, accent, css, modules.queue, modules.cover.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, bg: { type: 'string' }, fg: { type: 'string' }, accent: { type: 'string' }, css: { type: 'string', description: 'Custom CSS, under 10000 chars' }, modules: { type: 'object', properties: { queue: { type: 'boolean' }, cover: { type: 'boolean' } }, additionalProperties: false } }, additionalProperties: false } },
];

async function upstream(path, method, body) {
  const { base, upKey, timeout } = cfg();
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(base + path, {
      method, signal: ac.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': upKey },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body || {}) }),
    });
    const text = await r.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { message: text.slice(0, 500) }; }
    if (!r.ok) throw new Error('Backend ' + r.status + ': ' + (data.error || data.message || 'request failed'));
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Backend timed out after ' + timeout + 'ms');
    if (e.message && e.message.startsWith('Backend ')) throw e;
    throw new Error('Backend unreachable');
  } finally { clearTimeout(t); }
}

const str = (v, n) => typeof v === 'string' && v.trim() && v.length <= n;
async function callTool(name, a) {
  a = a && typeof a === 'object' ? a : {};
  switch (name) {
    case 'playSong': case 'queueSong':
      if (!str(a.query, 200)) throw new Error('query must be a non-empty string (max 200 chars)');
      return upstream(name === 'playSong' ? '/api/play' : '/api/queue', 'POST', { query: a.query.trim() });
    case 'control':
      if (a.action !== 'pause' && a.action !== 'resume') throw new Error('action must be "pause" or "resume"');
      return upstream('/api/control', 'POST', { action: a.action });
    case 'skip': return upstream('/api/skip', 'POST', {});
    case 'getState': return upstream('/api/state', 'GET');
    case 'updateSettings': {
      const o = {};
      for (const k of ['title', 'bg', 'fg', 'accent']) if (a[k] !== undefined) { if (!str(a[k], 200)) throw new Error(k + ' must be a short string'); o[k] = a[k]; }
      if (a.css !== undefined) { if (typeof a.css !== 'string' || a.css.length > 10000) throw new Error('css must be a string under 10000 chars'); o.css = a.css; }
      if (a.modules !== undefined) {
        if (!a.modules || typeof a.modules !== 'object') throw new Error('modules must be an object of booleans');
        o.modules = {};
        for (const k of ['queue', 'cover']) if (a.modules[k] !== undefined) { if (typeof a.modules[k] !== 'boolean') throw new Error('modules.' + k + ' must be boolean'); o.modules[k] = a.modules[k]; }
      }
      if (!Object.keys(o).length) throw new Error('no supported settings provided');
      return upstream('/api/settings', 'POST', o);
    }
    default: return null;
  }
}

const same = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function presentedKey(req) {
  const h = req.headers['authorization'] || '';
  const header = req.headers['x-api-key'] || (/^Bearer /i.test(h) ? h.slice(7).trim() : '');
  let fromUrl = '';
  try {
    const u = new URL(req.url, 'http://x');
    fromUrl = u.searchParams.get('key') || u.searchParams.get('token') || '';
  } catch (e) {}
  return String(header || fromUrl || '');
}
function authed(req) {
  const { inKey } = cfg();
  const given = presentedKey(req);
  return !!inKey && !!given && same(given, inKey);
}

const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });

function pickVersion(v) {
  const known = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
  if (known.includes(v)) return v;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return '2025-06-18';
}

async function handleMsg(m) {
  if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') return rpcErr(m && m.id, -32600, 'Invalid Request');
  if (typeof m.method !== 'string') return null;
  if (m.id === undefined || m.id === null) return null;
  const p = m.params || {};
  switch (m.method) {
    case 'initialize':
      return { jsonrpc: '2.0', id: m.id, result: { protocolVersion: pickVersion(p.protocolVersion), capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'sun-suna', version: '1.2.0' }, instructions: INSTRUCTIONS } };
    case 'ping': return { jsonrpc: '2.0', id: m.id, result: {} };
    case 'tools/list': return { jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } };
    case 'tools/call': {
      if (!TOOLS.some((t) => t.name === p.name)) return rpcErr(m.id, -32602, 'Unknown tool: ' + String(p.name).slice(0, 50));
      try {
        const data = await callTool(p.name, p.arguments);
        return { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false } };
      } catch (e) {
        console.error('tool error', p.name, e.message);
        return { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: e.message }], isError: true } };
      }
    }
    default: return rpcErr(m.id, -32601, 'Method not found');
  }
}

function send(res, status, data, extra) {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  for (const k in extra || {}) res.setHeader(k, extra[k]);
  if (data === undefined) return res.end();
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return send(res, 204, undefined, { Allow: 'POST, GET, DELETE, OPTIONS' });
  if (req.method === 'GET' || req.method === 'DELETE') return send(res, 405, { error: 'This MCP server is stateless. Use POST.' }, { Allow: 'POST, OPTIONS' });
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST for MCP requests' }, { Allow: 'POST, OPTIONS' });
  if (!cfg().inKey) { console.error('BRIDGE_API_KEY is not set'); return send(res, 503, { error: 'Bridge not configured' }); }
  if (!authed(req)) return send(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });

  let body;
  try { body = req.body; if (typeof body === 'string') body = JSON.parse(body); if (Buffer.isBuffer(body)) body = JSON.parse(body.toString('utf8')); }
  catch (e) { return send(res, 400, rpcErr(null, -32700, 'Parse error')); }
  if (body === undefined || body === null || typeof body !== 'object') return send(res, 400, rpcErr(null, -32700, 'Parse error'));

  if (Array
