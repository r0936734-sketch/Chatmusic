// Music mediator: player page + API for ChatGPT + state for the Sun Suna APK.
// Audio is NOT resolved here. The phone does RapidAPI: query -> YouTube link -> MP3.
// Env: API_KEY, UPSTASH_REDIS_REST_URL (or KV_REST_API_URL), UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_TOKEN).
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
'<h2>Sun Suna</h2><p>ChatGPT sends songs here. Open the Sun Suna app on your phone — it downloads the MP3 and plays it.</p>' +
'<pre id=s style="text-align:left;white-space:pre-wrap"></pre><script>' +
'function poll(){fetch("/api/state").then(function(r){return r.json()}).then(function(s){' +
'document.getElementById("s").textContent=JSON.stringify({seq:s.seq,now:s.now,queue:s.queue,cmd:s.cmd},null,2)})}' +
'poll();setInterval(poll,2000)</script>';

const schema = (host) => ({
  openapi: '3.1.0',
  info: { title: 'Sun Suna Music', version: '1.1.0', description: 'ChatGPT asks for a song. The Android app resolves it with RapidAPI and plays the MP3.' },
  servers: [{ url: 'https://' + host }],
  paths: {
    '/api/play': { post: { operationId: 'playSong', summary: 'Search and play a song now on the phone', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['query'], properties: { query: { type: 'string', description: 'Song title and artist' } } } } } }, responses: { 200: { description: 'ok' } } } },
    '/api/queue': { post: { operationId: 'queueSong', summary: 'Add a song to play after the current one', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } } } } }, responses: { 200: { description: 'ok' } } } },
    '/api/control': { post: { operationId: 'control', summary: 'Pause or resume playback on the phone', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['pause', 'resume'] } } } } } }, responses: { 200: { description: 'ok' } } } },
    '/api/skip': { post: { operationId: 'skip', summary: 'Skip to the next queued song', responses: { 200: { description: 'ok' } } } },
    '/api/state': { get: { operationId: 'getState', summary: 'Now playing, queue and UI settings', responses: { 200: { description: 'ok' } } } },
    '/api/settings': { post: { operationId: 'updateSettings', summary: 'Change title or colors. Optional.', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { title: { type: 'string' }, bg: { type: 'string' }, fg: { type: 'string' }, accent: { type: 'string' }, css: { type: 'string' }, modules: { type: 'object', additionalProperties: { type: 'boolean' } } } } } } }, responses: { 200: { description: 'ok' } } } },
  },
});

module.exports = async (req, res) => {
  const p = new URL(req.url, 'http://x').searchParams.get('p') || '';
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const ok = req.headers['x-api-key'] === E.API_KEY && !!E.API_KEY;
  const out = (o, c) => res.status(c || 200).json(o);
  try {
    if (p === '') { res.setHeader('content-type', 'text/html'); return res.status(200).send(HTML); }
    if (p === 'openapi.json') return out(schema(req.headers.host));
    const s = await load();
    if (p === 'state') return out(s);
    if (p === 'next') {
      if (b.seq !== undefined && Number(b.seq) !== s.seq) return out({ ok: true });
      if (s.queue.length) { s.now = s.queue.shift(); s.seq++; await save(s); }
      return out({ ok: true, now: s.now });
    }
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
  } catch (e) { return out({ error: String(e) }, 500); }
};
