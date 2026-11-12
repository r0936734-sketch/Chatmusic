
// api/float.js — FloatCanvas bridge: floating-overlay state + ChatGPT MCP connector.
// Reuses your existing env vars: API_KEY, BRIDGE_API_KEY, UPSTASH_REDIS_REST_URL/TOKEN (or KV_REST_API_*)
// Stores its own data under the Redis key "float" (does not touch the music key "st").
//
// ChatGPT connector URL : https://chatmusic-mocha.vercel.app/api/float/mcp/BRIDGE_API_KEY
// Phone app polls       : GET  https://chatmusic-mocha.vercel.app/api/float/state?since=VER   (header x-api-key: API_KEY)
// Manual test push      : POST https://chatmusic-mocha.vercel.app/api/float/push              (header x-api-key: API_KEY)
const crypto = require('crypto');
const E = process.env;
const RU = E.UPSTASH_REDIS_REST_URL || E.KV_REST_API_URL;
const RT = E.UPSTASH_REDIS_REST_TOKEN || E.KV_REST_API_TOKEN;
const KEY = 'float';
const MAX_HTML = 200000;
const SIZES = ['small', 'half', 'full', 'bubble'];

const rd = async (...c) =>
  (await (await fetch(RU, { method: 'POST', headers: { Authorization: 'Bearer ' + RT }, body: JSON.stringify(c) })).json()).result;
const init = () => ({ ver: 0, html: '', size: 'half' });
const load = async () => { try { return JSON.parse(await rd('GET', KEY)) || init(); } catch (e) { return init(); } };
const save = (s) => rd('SET', KEY, JSON.stringify(s));

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } });
const pickVersion = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '2025-06-18');

function send(res, status, data, extra) {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  for (const k in extra || {}) res.setHeader(k, extra[k]);
  if (data === undefined) return res.end();
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

const INSTRUCTIONS =
  'You control a floating overlay window on the user\'s Android phone. It is a blank WebView that renders any HTML you send. ' +
  'Use setScreen with one complete, self-contained HTML document (inline CSS and JS only, no external files, fonts, images or CDN links). ' +
  'Design for a phone: dark background, large touch targets, responsive layout, no horizontal scroll. ' +
  'The window can be small, half, full or bubble: use setSize to change it, or pass size to setScreen. ' +
  'To change something, resend the full updated page. Use clearScreen to blank it. Use getScreen to see what is currently shown. ' +
  'The page cannot reach the internet or the phone\'s apps, so build things that work on their own (timers, notes, calculators, games, dashboards with data you embed). ' +
  'After a tool succeeds, reply with one short sentence. If a tool errors, say the phone bridge rejected it and do not claim it worked.';

const sizeEnum = { type: 'string', enum: SIZES };
const none = { type: 'object', properties: {}, additionalProperties: false };
const TOOLS = [
  {
    name: 'setScreen',
    description: 'Replace the floating window content with a complete self-contained HTML document. Optionally set the window size.',
    inputSchema: { type: 'object', properties: { html: { type: 'string', description: 'Full HTML document. Inline CSS/JS only. Max 200000 chars.' }, size: sizeEnum }, required: ['html'], additionalProperties: false },
  },
  {
    name: 'setSize',
    description: 'Resize the floating window: small, half (half screen), full (full screen) or bubble (collapsed to a small draggable bubble).',
    inputSchema: { type: 'object', properties: { mode: sizeEnum }, required: ['mode'], additionalProperties: false },
  },
  { name: 'clearScreen', description: 'Blank the floating window.', inputSchema: none },
  { name: 'getScreen', description: 'Read the current window size and HTML.', inputSchema: none, annotations: { readOnlyHint: true } },
];

async function tool(name, a) {
  a = a && typeof a === 'object' ? a : {};
  if (name === 'setScreen') {
    if (typeof a.html !== 'string' || !a.html.trim()) throw new Error('html must be a non-empty string');
    if (a.html.length > MAX_HTML) throw new Error('html too large (max ' + MAX_HTML + ' chars)');
    if (a.size !== undefined && !SIZES.includes(a.size)) throw new Error('size must be one of ' + SIZES.join(', '));
    const s = await load();
    s.html = a.html;
    if (a.size) s.size = a.size;
    s.ver++;
    await save(s);
    return { ok: true, ver: s.ver, size: s.size };
  }
  if (name === 'setSize') {
    if (!SIZES.includes(a.mode)) throw new Error('mode must be one of ' + SIZES.join(', '));
    const s = await load();
    s.size = a.mode;
    s.ver++;
    await save(s);
    return { ok: true, ver: s.ver, size: s.size };
  }
  if (name === 'clearScreen') {
    const s = await load();
    s.html = '';
    s.ver++;
    await save(s);
    return { ok: true, ver: s.ver };
  }
  if (name === 'getScreen') {
    const s = await load();
    return { ver: s.ver, size: s.size, htmlLength: s.html.length, html: s.html.slice(0, 20000) };
  }
  return null;
}

async function handleMsg(m) {
  if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') return rpcErr(m && m.id, -32600, 'Invalid Request');
  if (typeof m.method !== 'string') return null;
  if (m.id === undefined || m.id === null) return null; // notification
  const p = m.params || {};
  if (m.method === 'initialize') {
    return { jsonrpc: '2.0', id: m.id, result: { protocolVersion: pickVersion(p.protocolVersion), capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'floatcanvas', version: '1.0.0' }, instructions: INSTRUCTIONS } };
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

async function mcp(req, res, bridgeKey) {
  const expect = E.BRIDGE_API_KEY || '';
  if (!expect) return send(res, 503, { error: 'Set BRIDGE_API_KEY on Vercel' });
  if (!bridgeKey || !same(bridgeKey, expect)) return send(res, 401, { error: 'Unauthorized' });
  if (req.method === 'GET') return send(res, 200, { ok: true, name: 'floatcanvas', tools: TOOLS.map((t) => t.name) });
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
    if (p === 'mcp') return mcp(req, res, u.searchParams.get('k') || '');
    if (p === '') return send(res, 200, { ok: true, name: 'floatcanvas' });

    const authed = !!E.API_KEY && same(req.headers['x-api-key'] || '', E.API_KEY);
    if (!authed) return send(res, 401, { error: 'bad api key' });

    // Phone app polling: GET /api/float/state?since=VER
    if (p === 'state') {
      const s = await load();
      const since = Number(u.searchParams.get('since'));
      if (Number.isFinite(since) && since === s.ver) return send(res, 200, { ver: s.ver, changed: false });
      return send(res, 200, { ver: s.ver, changed: true, html: s.html, size: s.size });
    }

    // Manual push for testing with curl: POST /api/float/push  {html?, size?, clear?}
    if (p === 'push') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
      let b = req.body;
      if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
      b = b && typeof b === 'object' && !Buffer.isBuffer(b) ? b : {};
      const s = await load();
      if (b.clear) s.html = '';
      if (typeof b.html === 'string') {
        if (b.html.length > MAX_HTML) return send(res, 400, { error: 'html too large' });
        s.html = b.html;
      }
      if (b.size !== undefined) {
        if (!SIZES.includes(b.size)) return send(res, 400, { error: 'bad size' });
        s.size = b.size;
      }
      s.ver++;
      await save(s);
      return send(res, 200, { ok: true, ver: s.ver, size: s.size });
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: String((e && e.message) || e) });
  }
};
    
