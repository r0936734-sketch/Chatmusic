// Music mediator: one function = player UI + API for ChatGPT + state for the APK.
const E = process.env;
const RU = E.UPSTASH_REDIS_REST_URL || E.KV_REST_API_URL;
const RT = E.UPSTASH_REDIS_REST_TOKEN || E.KV_REST_API_TOKEN;
const rd = async (...c) =>
  (await (await fetch(RU, { method: 'POST', headers: { Authorization: 'Bearer ' + RT }, body: JSON.stringify(c) })).json()).result;

const init = () => ({
  seq: 0, now: null, queue: [], cmd: null,
  settings: { title: 'My Music', bg: '#111111', fg: '#ffffff', accent: '#1db954', css: '', modules: { queue: true, cover: true } },
});
const load = async () => { try { return JSON.parse(await rd('GET', 'st')) || init(); } catch (e) { return init(); } };
const save = (s) => rd('SET', 'st', JSON.stringify(s));

async function find(q) {
  const u = 'https://api.jamendo.com/v3.0/tracks/?client_id=' + E.JAMENDO_CLIENT_ID +
    '&format=json&limit=5&audioformat=mp32&search=' + encodeURIComponent(q);
  const j = await (await fetch(u)).json();
  return (j.results || []).map((t) => ({ id: t.id, title: t.name, artist: t.artist_name, url: t.audio, img: t.image }));
}

const HTML = '<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Music</title>' +
'<style id=th></style><style id=cu></style><body><h2 id=t></h2><img id=im hidden width=240><div id=np>Nothing playing</div>' +
'<audio id=a controls></audio><div id=qu></div><script>' +
'var seq=-1,cmd=0,$=function(i){return document.getElementById(i)};' +
'var esc=function(s){return String(s).replace(/[&<>"]/g,function(c){return "&#"+c.charCodeAt(0)+";"})};' +
'function poll(){fetch("/api/state").then(function(r){return r.json()}).then(function(s){var c=s.settings,m=c.modules;' +
'$("th").textContent=":root{--bg:"+c.bg+";--fg:"+c.fg+";--ac:"+c.accent+"}body{background:var(--bg);color:var(--fg);font-family:sans-serif;padding:16px;text-align:center}audio{width:100%;margin:12px 0}";' +
'$("cu").textContent=c.css;$("t").textContent=c.title;$("qu").hidden=!m.queue;$("im").hidden=!m.cover||!s.now;' +
'$("qu").innerHTML=s.queue.map(function(x){return "<div>"+esc(x.title)+" - "+esc(x.artist)+"</div>"}).join("");' +
'if(s.seq!==seq){seq=s.seq;if(s.now){$("a").src=s.now.url;$("a").play();$("im").src=s.now.img||"";' +
'$("np").textContent=s.now.title+" - "+s.now.artist;if(window.AndroidBridge)AndroidBridge.setNowPlaying(s.now.title,s.now.artist)}}' +
'if(s.cmd&&s.cmd.id!==cmd){cmd=s.cmd.id;if(s.cmd.a==="pause")$("a").pause();else $("a").play()}})}' +
'$("a").onended=function(){fetch("/api/next",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({seq:seq})}).then(poll)};' +
'window.onNativeCommand=function(a){if(a==="next")$("a").onended();else if(a==="pause")$("a").pause();else $("a").play()};' +
'poll();setInterval(poll,2000)</script>';

const schema = (host) => ({
  openapi: '3.1.0',
  info: { title: 'Music Player', version: '1.0.0' },
  servers: [{ url: 'https://' + host }],
  paths: {
    '/api/play': { post: { operationId: 'playSong', summary: 'Search and play a song now', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } } } } }, responses: { 200: { description: 'ok' } } } },
    '/api/queue': { post: { operationId: 'queueSong', summary: 'Add a song to play after the current one', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } } } } }, responses: { 200: { description: 'ok' } } } },
    '/api/control': { post: { operationId: 'control', summary: 'Pause or resume', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['pause', 'resume'] } } } } } }, responses: { 200: { description: 'ok' } } } },
    '/api/skip': { post: { operationId: 'skip', summary: 'Skip to next queued song', responses: { 200: { description: 'ok' } } } },
    '/api/state': { get: { operationId: 'getState', summary: 'Now playing, queue and UI settings', responses: { 200: { description: 'ok' } } } },
    '/api/settings': { post: { operationId: 'updateSettings', summary: 'Change the app UI. Fields: title, bg, fg, accent (colors), css (custom CSS string), modules (object of booleans: queue, cover)', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { title: { type: 'string' }, bg: { type: 'string' }, fg: { type: 'string' }, accent: { type: 'string' }, css: { type: 'string' }, modules: { type: 'object', additionalProperties: { type: 'boolean' } } } } } } }, responses: { 200: { description: 'ok' } } } },
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
    if (p === 'next') { // called by the player when a song ends; seq guard stops double-skips
      if (b.seq !== undefined && b.seq !== s.seq) return out({ ok: true });
      if (s.queue.length) { s.now = s.queue.shift(); s.seq++; await save(s); }
      return out({ ok: true, now: s.now });
    }
    if (!ok) return out({ error: 'bad api key' }, 401);
    if (p === 'play' || p === 'queue') {
      const r = await find(b.query || '');
      if (!r.length) return out({ error: 'no track found' }, 404);
      if (p === 'play') { s.now = r[0]; s.seq++; } else s.queue.push(r[0]);
      await save(s); return out({ ok: true, track: r[0] });
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
