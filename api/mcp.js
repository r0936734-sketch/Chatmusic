// MCP bridge (Streamable HTTP, stateless) -> forwards to the Chat Music API.
// Env: BRIDGE_API_KEY (incoming), CHAT_MUSIC_API_KEY (upstream; falls back to API_KEY),
//      CHAT_MUSIC_API_BASE (default https://chatmusic-mocha.vercel.app), CHAT_MUSIC_TIMEOUT_MS (default 8000)
const crypto = require('crypto');

const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const E = process.env;
const cfg = () => ({
  base: (E.CHAT_MUSIC_API_BASE || 'https://chatmusic-mocha.vercel.app').replace(/\/+$/, ''),
  upKey: E.CHAT_MUSIC_API_KEY || E.API_KEY || '',
  inKey: E.BRIDGE_API_KEY || '',
  timeout: Number(E.CHAT_MUSIC_TIMEOUT_MS) || 8000,
});

const q = { type: 'object', properties: { query: { type: 'string', description: 'Song title and/or artist' } }, required: ['query'], additionalProperties: false };
const none = { type: 'object', properties: {}, additionalProperties: false };
const TOOLS = [
  { name: 'playSong', description: 'Search Jamendo and play a song immediately.', inputSchema: q },
  { name: 'queueSong', description: 'Add a song to play after the current one.', inputSchema: q },
  { name: 'control', description: 'Pause or resume playback.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['pause', 'resume'] } }, required: ['action'], additionalProperties: false } },
  { name: 'skip', description: 'Skip to the next queued song.', inputSchema: none },
  { name: 'getState', description: 'Get current song, queue and UI settings.', inputSchema: none, annotations: { readOnlyHint: true } },
  { name: 'updateSettings', description: 'Change the player UI. Send only the fields to change.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, bg: { type: 'string' }, fg: { type: 'string' }, accent: { type: 'string' }, css: { type: 'string', description: 'Custom CSS' }, modules: { type: 'object', properties: { queue: { type: 'boolean' }, cover: { type: 'boolean' } }, additionalProperties: false } }, additionalProperties: false } },
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
    if (e.message.startsWith('Backend ')) throw e;
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

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function authed(req) {
  const { inKey } = cfg();
  const h = req.headers['authorization'] || '';
  const given = req.headers['x-api-key'] || (/^Bearer /i.test(h) ? h.slice(7).trim() : '');
  return !!inKey && !!given && same(given, inKey);
}

const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });

async function handleMsg(m) {
  if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') return rpcErr(m && m.id, -32600, 'Invalid Request');
  const isReq = typeof m.method === 'string';
  if (!isReq) return null;                         // client responses are acknowledged only
  if (m.id === undefined || m.id === null) return null; // notification: no reply
  const p = m.params || {};
  switch (m.method) {
    case 'initialize': {
      const v = SUPPORTED.includes(p.protocolVersion) ? p.protocolVersion : SUPPORTED[0];
      return { jsonrpc: '2.0', id: m.id, result: { protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'chat-music', version: '1.1.0' } } };
    }
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
  if (req.method === 'OPTIONS') return send(res, 204, undefined, { Allow: 'POST, OPTIONS' });
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST for MCP requests' }, { Allow: 'POST, OPTIONS' });
  if (!cfg().inKey) { console.error('BRIDGE_API_KEY is not set'); return send(res, 503, { error: 'Bridge not configured' }); }
  if (!authed(req)) return send(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });

  let body;
  try { body = req.body; if (typeof body === 'string') body = JSON.parse(body); }
  catch (e) { return send(res, 400, rpcErr(null, -32700, 'Parse error')); }
  if (body === undefined || body === null || typeof body !== 'object') return send(res, 400, rpcErr(null, -32700, 'Parse error'));

  if (Array.isArray(body)) {
    if (!body.length) return send(res, 400, rpcErr(null, -32600, 'Invalid Request'));
    const out = (await Promise.all(body.map(handleMsg))).filter(Boolean);
    return out.length ? send(res, 200, out) : send(res, 202);
  }
  const out = await handleMsg(body);
  return out ? send(res, out.error && out.error.code === -32600 ? 400 : 200, out) : send(res, 202);
};
