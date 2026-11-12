// api/float.js â€” FloatCanvas bridge: floating-overlay state + ChatGPT MCP connector.
// Reuses API_KEY, BRIDGE_API_KEY, UPSTASH_REDIS_REST_URL/TOKEN (or KV_REST_API_*).
// Screen state stays on Redis key "float". Files use "float:inbox" (queue) and
// "float:held" (the one item currently checked out to the phone). A file is
// removed from Redis once the phone acks it, or on the next poll that reports
// it was received. Nothing here touches the music key "st".
//
// ChatGPT connector : https://HOST/api/float/mcp/BRIDGE_API_KEY
// Phone poll        : GET  /api/float/state?since=VER&caps=file&got=FILEID   (x-api-key)
// Phone ack         : POST /api/float/ack   { "id": "FILEID" }                (x-api-key)
// Manual push       : POST /api/float/push  { html?, size?, clear?, file? }   (x-api-key)
const crypto = require('crypto');
const E = process.env;
const RU = E.UPSTASH_REDIS_REST_URL || E.KV_REST_API_URL;
const RT = E.UPSTASH_REDIS_REST_TOKEN || E.KV_REST_API_TOKEN;
const KEY = 'float';
const INBOX = 'float:inbox';
const HELD = 'float:held';
const MAX_HTML = 200000;
const MAX_BYTES = 600000;
const MAX_B64 = 900000;
const MAX_QUEUE = 8;
const HELD_TTL = 15 * 60 * 1000;
const ITEM_TTL = 30 * 60 * 1000;
const SIZES = ['small', 'half', 'full', 'bubble'];

const rd = async (...c) => {
  if (!RU || !RT) throw new Error('Redis is not configured');
  const res = await fetch(RU, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + RT },
    body: JSON.stringify(c),
  });
  const json = await res.json();
  if (json && json.error) throw new Error(String(json.error));
  return json ? json.result : null;
};

const init = () => ({ ver: 0, html: '', size: 'half', sizeRev: 0 });
const load = async () => {
  try {
    const raw = await rd('GET', KEY);
    const parsed = JSON.parse(raw) || init();
    if (typeof parsed.sizeRev !== 'number') parsed.sizeRev = 0;
    if (typeof parsed.ver !== 'number') parsed.ver = 0;
    if (typeof parsed.html !== 'string') parsed.html = '';
    if (!SIZES.includes(parsed.size)) parsed.size = 'half';
    return parsed;
  } catch (e) {
    return init();
  }
};
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

function readBody(req) {
  let b = req.body;
  if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch (e) { return null; }
  }
  if (Buffer.isBuffer(b)) {
    try { b = JSON.parse(b.toString('utf8')); } catch (e) { return null; }
  }
  return b;
}

const INSTRUCTIONS =
  'You control a floating overlay on the user\'s Android phone. It is a WebView. ' +
  'Use setScreen with one complete HTML document and inline CSS/JS. ' +
  'React 18, ReactDOM and htm are bundled on the phone â€” load them from ' +
  'https://floatcanvas.local/react.js , https://floatcanvas.local/react-dom.js and https://floatcanvas.local/htm.js ' +
  '(htm.bind(React.createElement) gives you tagged HTML without a build step). ' +
  'Other https URLs work only while the phone is online. ' +
  'The user can drag the window from the bar and from every corner, and resize it from the right edge, the bottom edge and the bottom-right grip, ' +
  'so the viewport changes under you. Lay the page out fluidly: width 100%, flex or grid, overflow auto on the body, no fixed canvas larger than the window. ' +
  'Listen for resize and floatresize. A resize must not clip â€” if it does not fit, it should scroll inside the page. ' +
  'Presets are small, half, full and bubble via setSize, or pass size to setScreen. Resend the full page to change it. clearScreen blanks it. getScreen reads it. ' +
  'Files: sendImage or sendFile queues ONE item. The phone deletes it from the database as soon as it is received, so do not expect to read the bytes back. ' +
  'Wait until getScreen inbox is 0 before sending another if you need to be sure it was collected. Max about 600KB. Pass base64 data or an https url. ' +
  'On the page, listen for the floatfile event (detail.url, detail.name, detail.mime, detail.note) or read FloatCanvas.files. ' +
  'An element with id fc-slot is filled automatically. ' +
  'After a tool succeeds, reply with one short sentence. If a tool errors, say the phone bridge rejected it and do not claim it worked.';

const sizeEnum = { type: 'string', enum: SIZES };
const none = { type: 'object', properties: {}, additionalProperties: false };
const fileProps = {
  name: { type: 'string', description: 'File name, no path.' },
  mime: { type: 'string', description: 'MIME type. Optional if it can be sniffed or comes from a data URL.' },
  data: { type: 'string', description: 'Base64 or a data URL. Omit when url is set. Max about 600KB.' },
  url: { type: 'string', description: 'https URL. The server downloads it once, stores the bytes, and the phone then deletes them.' },
  note: { type: 'string', description: 'Short caption shown with the file. Max 140 characters.' },
};
const TOOLS = [
  {
    name: 'setScreen',
    description: 'Replace the floating window with a complete HTML document. Optionally set the window size. Prefer fluid layout; the user can resize the window.',
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'Full HTML document. Inline CSS/JS, or the bundled floatcanvas.local runtime. Max 200000 chars.' },
        size: sizeEnum,
      },
      required: ['html'],
      additionalProperties: false,
    },
  },
  {
    name: 'setSize',
    description: 'Resize the floating window: small, half, full, or bubble. The user can still drag and free-resize afterward.',
    inputSchema: { type: 'object', properties: { mode: sizeEnum }, required: ['mode'], additionalProperties: false },
  },
  { name: 'clearScreen', description: 'Blank the floating window.', inputSchema: none },
  {
    name: 'getScreen',
    description: 'Read the current window size, HTML, and how many files are still waiting in the inbox.',
    inputSchema: none,
    annotations: { readOnlyHint: true },
  },
  {
    name: 'sendFile',
    description: 'Queue one file for the phone. It is deleted from the database as soon as the overlay receives it. Send the next only after this one is collected if order matters.',
    inputSchema: { type: 'object', properties: fileProps, additionalProperties: false },
  },
  {
    name: 'sendImage',
    description: 'Queue one image for the phone (png, jpeg, webp, gif, or svg). Deleted from the database once the overlay receives it. Pass data or an https url.',
    inputSchema: { type: 'object', properties: fileProps, additionalProperties: false },
  },
  { name: 'clearInbox', description: 'Delete every file still waiting in the inbox, including the one checked out to the phone.', inputSchema: none },
];

function cleanName(name, mime) {
  let n = String(name || '').replace(/[\\/\0\r\n]/g, '').trim().slice(0, 80);
  if (!n) n = String(mime || '').startsWith('image/') ? 'image' : 'file';
  return n;
}
function cleanMime(mime) {
  const m = String(mime || '').toLowerCase().split(';')[0].trim();
  if (/^[\w.+-]+\/[\w.+-]+$/.test(m)) return m.slice(0, 80);
  return '';
}
function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h === 'metadata.google.internal') return true;
  if (h.includes(':')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const p = m.slice(1).map(Number);
  if (p.some((n) => n > 255)) return true;
  const a = p[0], b = p[1];
  if (a === 10 || a === 127 || a === 0 || a >= 224) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}
function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { throw new Error('bad url'); }
  if (u.protocol !== 'https:') throw new Error('only https urls');
  if (isPrivateHost(u.hostname)) throw new Error('url blocked');
  return u;
}
function sniff(buf, hinted) {
  if (hinted && hinted !== 'application/octet-stream') return hinted;
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6) {
    const tag = buf.slice(0, 6).toString('ascii');
    if (tag === 'GIF87a' || tag === 'GIF89a') return 'image/gif';
  }
  if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  const head = buf.slice(0, 180).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return hinted || 'application/octet-stream';
}
function payloadFromData(input, hinted) {
  let mime = cleanMime(hinted);
  let data = String(input || '').trim();
  const m = data.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
  if (m) {
    mime = cleanMime(m[1]) || mime;
    data = m[2];
  }
  data = data.replace(/\s+/g, '');
  if (!data) throw new Error('file is empty');
  if (data.length > MAX_B64) throw new Error('file too large (max 600KB)');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error('data must be base64');
  const buf = Buffer.from(data, 'base64');
  if (!buf.length) throw new Error('file is empty');
  if (buf.length > MAX_BYTES) throw new Error('file too large (max 600KB)');
  mime = sniff(buf, mime);
  return { mime, data: buf.toString('base64'), bytes: buf.length };
}
async function payloadFromUrl(url, hinted) {
  let current = assertPublicUrl(url).href;
  for (let hop = 0; hop < 3; hop++) {
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'FloatCanvas/2.1', Accept: '*/*' },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error('bad redirect');
      current = assertPublicUrl(new URL(loc, current).href).href;
      continue;
    }
    if (!res.ok) throw new Error('fetch failed HTTP ' + res.status);
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) throw new Error('file too large (max 600KB)');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('file too large (max 600KB)');
    if (!buf.length) throw new Error('file is empty');
    let mime = cleanMime(hinted) || cleanMime(res.headers.get('content-type') || '');
    mime = sniff(buf, mime);
    return { mime, data: buf.toString('base64'), bytes: buf.length };
  }
  throw new Error('too many redirects');
}
async function readHeld() {
  const raw = await rd('GET', HELD);
  if (!raw || typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
async function inboxDepth() {
  const n = Number(await rd('LLEN', INBOX)) || 0;
  const held = await readHeld();
  return n + (held && held.id ? 1 : 0);
}
async function enqueue(a, imageOnly) {
  a = a && typeof a === 'object' ? a : {};
  const note = String(a.note || '').replace(/[\u0000\r\n]/g, ' ').trim().slice(0, 140);
  let packed;
  if (typeof a.data === 'string' && a.data.trim()) packed = payloadFromData(a.data, a.mime);
  else if (typeof a.url === 'string' && a.url.trim()) packed = await payloadFromUrl(a.url.trim(), a.mime);
  else throw new Error('pass data (base64) or an https url');
  if (imageOnly && !packed.mime.startsWith('image/')) throw new Error('sendImage needs an image');
  const depth = await inboxDepth();
  if (depth >= MAX_QUEUE) throw new Error('inbox full (' + MAX_QUEUE + '). Wait for the phone to collect them.');
  const item = {
    id: crypto.randomBytes(8).toString('hex'),
    name: cleanName(a.name, packed.mime),
    mime: packed.mime,
    data: packed.data,
    note,
    bytes: packed.bytes,
    at: Date.now(),
  };
  await rd('RPUSH', INBOX, JSON.stringify(item));
  return { ok: true, id: item.id, name: item.name, mime: item.mime, bytes: item.bytes, inbox: depth + 1 };
}
function publicFile(item) {
  if (!item || !item.id || !item.data) return null;
  return {
    id: String(item.id),
    name: String(item.name || 'file'),
    mime: String(item.mime || 'application/octet-stream'),
    data: String(item.data),
    note: String(item.note || ''),
    bytes: Number(item.bytes) || 0,
  };
}
async function takeFile(got) {
  let held = await readHeld();
  const expired = held && held.heldAt && Date.now() - held.heldAt > HELD_TTL;
  if (held && (expired || (got && got === held.id))) {
    await rd('DEL', HELD);
    held = null;
  }
  if (!held) {
    for (let i = 0; i < MAX_QUEUE; i++) {
      const raw = await rd('LPOP', INBOX);
      if (!raw || typeof raw !== 'string') break;
      let item;
      try { item = JSON.parse(raw); } catch (e) { continue; }
      if (!item || !item.id || !item.data) continue;
      if (item.at && Date.now() - item.at > ITEM_TTL) continue;
      item.heldAt = Date.now();
      await rd('SET', HELD, JSON.stringify(item));
      held = item;
      break;
    }
  }
  return publicFile(held);
}
async function ackFile(id) {
  if (!id) return { ok: true };
  const held = await readHeld();
  if (held && held.id === id) await rd('DEL', HELD);
  return { ok: true };
}
async function clearInbox() {
  await rd('DEL', INBOX);
  await rd('DEL', HELD);
  return { ok: true, inbox: 0 };
}

async function tool(name, a) {
  if (typeof a === 'string') {
    try { a = JSON.parse(a); } catch (e) { a = {}; }
  }
  a = a && typeof a === 'object' ? a : {};
  if (name === 'setScreen') {
    if (typeof a.html !== 'string' || !a.html.trim()) throw new Error('html must be a non-empty string');
    if (a.html.length > MAX_HTML) throw new Error('html too large (max ' + MAX_HTML + ' chars)');
    if (a.size !== undefined && !SIZES.includes(a.size)) throw new Error('size must be one of ' + SIZES.join(', '));
    const s = await load();
    s.html = a.html;
    if (a.size) {
      s.size = a.size;
      s.sizeRev = (s.sizeRev || 0) + 1;
    }
    s.ver++;
    await save(s);
    return { ok: true, ver: s.ver, size: s.size, sizeRev: s.sizeRev || 0 };
  }
  if (name === 'setSize') {
    if (!SIZES.includes(a.mode)) throw new Error('mode must be one of ' + SIZES.join(', '));
    const s = await load();
    s.size = a.mode;
    s.sizeRev = (s.sizeRev || 0) + 1;
    s.ver++;
    await save(s);
    return { ok: true, ver: s.ver, size: s.size, sizeRev: s.sizeRev };
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
    let inbox = 0;
    try { inbox = await inboxDepth(); } catch (e) { inbox = 0; }
    return { ver: s.ver, size: s.size, sizeRev: s.sizeRev || 0, htmlLength: (s.html || '').length, html: String(s.html || '').slice(0, 20000), inbox };
  }
  if (name === 'sendFile') return enqueue(a, false);
  if (name === 'sendImage') return enqueue(a, true);
  if (name === 'clearInbox') return clearInbox();
  return null;
}

async function handleMsg(m) {
  if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') return rpcErr(m && m.id, -32600, 'Invalid Request');
  if (typeof m.method !== 'string') return null;
  if (m.id === undefined || m.id === null) return null;
  const p = m.params || {};
  if (m.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: m.id,
      result: {
        protocolVersion: pickVersion(p.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'floatcanvas', version: '2.1.0' },
        instructions: INSTRUCTIONS,
      },
    };
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
  if (req.method === 'GET') return send(res, 200, { ok: true, name: 'floatcanvas', version: '2.1.0', tools: TOOLS.map((t) => t.name) });
  if (req.method === 'OPTIONS') return send(res, 204, undefined, { Allow: 'POST, GET, OPTIONS' });
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' }, { Allow: 'POST, GET, OPTIONS' });
  let body;
  try {
    body = readBody(req);
  } catch (e) {
    return send(res, 400, rpcErr(null, -32700, 'Parse error'));
  }
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
    if (p === '') return send(res, 200, { ok: true, name: 'floatcanvas', version: '2.1.0' });
    const authed = !!E.API_KEY && same(req.headers['x-api-key'] || '', E.API_KEY);
    if (!authed) return send(res, 401, { error: 'bad api key' });

    if (p === 'state') {
      const s = await load();
      const since = Number(u.searchParams.get('since'));
      const caps = u.searchParams.get('caps') || '';
      let file = null;
      if (caps.indexOf('file') !== -1) {
        try { file = await takeFile(u.searchParams.get('got') || ''); } catch (e) { file = null; }
      }
      const unchanged = Number.isFinite(since) && since === s.ver;
      if (unchanged) {
        const body = { ver: s.ver, changed: false };
        if (file) body.file = file;
        return send(res, 200, body);
      }
      const body = { ver: s.ver, changed: true, html: s.html || '', size: s.size, sizeRev: s.sizeRev || 0 };
      if (file) body.file = file;
      return send(res, 200, body);
    }

    if (p === 'ack') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
      const b = readBody(req) || {};
      const out = await ackFile(String(b.id || ''));
      return send(res, 200, out);
    }

    if (p === 'push') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
      const b = readBody(req) || {};
      const s = await load();
      let touched = false;
      if (b.clear) { s.html = ''; touched = true; }
      if (typeof b.html === 'string') {
        if (b.html.length > MAX_HTML) return send(res, 400, { error: 'html too large' });
        s.html = b.html;
        touched = true;
      }
      if (b.size !== undefined) {
        if (!SIZES.includes(b.size)) return send(res, 400, { error: 'bad size' });
        if (b.size !== s.size) s.sizeRev = (s.sizeRev || 0) + 1;
        s.size = b.size;
        touched = true;
      }
      if (touched) {
        s.ver++;
        await save(s);
      }
      let queued = null;
      if (b.file && typeof b.file === 'object') queued = await enqueue(b.file, false);
      return send(res, 200, { ok: true, ver: s.ver, size: s.size, sizeRev: s.sizeRev || 0, file: queued });
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: String((e && e.message) || e) });
  }
};
