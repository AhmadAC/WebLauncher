// =========================================================================
// VIRTUAL LOCAL SERVER (Service Worker)
// Serves every imported app from IndexedDB under  /__vfs__/<appId>/<path>
// so apps run on a real http(s) origin: relative paths, ES modules, Web
// Workers, fetch() and WebAssembly streaming all behave as on a web server.
// =========================================================================
// Prefix is derived from the SW scope so it also works when the launcher is hosted in a sub-folder
// (e.g. https://user.github.io/WebLauncher/ -> /WebLauncher/__vfs__/).
const VFS_PREFIX = new URL('__vfs__/', self.registration.scope).pathname;
const DB_NAME = 'LauncherDB';
const STORE = 'apps';

const appCache = new Map(); // appId -> { app, index }

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'vfs-clear') {
    if (msg.id == null) appCache.clear();
    else appCache.delete(String(msg.id));
  }
});

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getFromStore(db, key) {
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    } catch (e) { resolve(undefined); }
  });
}

async function loadApp(id) {
  if (appCache.has(id)) return appCache.get(id);
  const db = await openDb();
  let app = await getFromStore(db, id);
  if (!app && !isNaN(Number(id))) app = await getFromStore(db, Number(id));
  db.close();
  if (!app) return null;

  const files = app.files || (app.code ? { 'index.html': { content: app.code, isBinary: false, type: 'text/html' } } : {});
  // Case-insensitive lookup index
  const index = new Map();
  for (const key of Object.keys(files)) {
    index.set(key.replace(/^\.?\//, '').toLowerCase(), key);
  }
  const entry = { app, files, index, bytes: new Map() };
  appCache.set(id, entry);
  return entry;
}

function decodeBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function fileBytes(entry, key) {
  if (entry.bytes.has(key)) return entry.bytes.get(key);
  const f = entry.files[key];
  const data = f.isBinary ? decodeBase64(f.content) : new TextEncoder().encode(f.content);
  entry.bytes.set(key, data);
  return data;
}

const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8', wasm: 'application/wasm',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', avif: 'image/avif',
  wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4',
  mp4: 'video/mp4', webm: 'video/webm', txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8', xml: 'application/xml', woff: 'font/woff',
  woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', webmanifest: 'application/manifest+json',
  data: 'application/octet-stream', bin: 'application/octet-stream'
};

function mimeFor(path, stored) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  if (MIME[ext]) return MIME[ext];
  return stored || 'application/octet-stream';
}

// Same bridge the iframe/srcdoc runtime injects: Capacitor plugins + error logging into the launcher log.
const BRIDGE = `<script id="native-runtime-bridge">
(function(){try{
  var P = window.parent;
  if (!P || P === window) return;
  if (!window.Capacitor && P.Capacitor) window.Capacitor = P.Capacitor;
  if (window.Capacitor && P.Capacitor && P.Capacitor.Plugins) {
    window.Capacitor.Plugins = window.Capacitor.Plugins || {};
    for (var k in P.Capacitor.Plugins) if (!window.Capacitor.Plugins[k]) window.Capacitor.Plugins[k] = P.Capacitor.Plugins[k];
  }
  if (!window.BluetoothLe) window.BluetoothLe = P.BluetoothLe || (P.Capacitor && P.Capacitor.Plugins && P.Capacitor.Plugins.BluetoothLe) || null;
  if (!window.Smb) window.Smb = P.Smb || (P.Capacitor && P.Capacitor.Plugins && P.Capacitor.Plugins.Smb) || null;
  if (!window.TextToSpeech) window.TextToSpeech = P.TextToSpeech || (P.Capacitor && P.Capacitor.Plugins && P.Capacitor.Plugins.TextToSpeech) || null;
  if (P.recordChildLog) {
    window.recordChildLog = P.recordChildLog;
    var oe = console.error;
    console.error = function(){ try{ P.recordChildLog('APP_ERR', Array.prototype.map.call(arguments, String).join(' ')); }catch(e){} return oe.apply(console, arguments); };
    window.addEventListener('error', function(ev){ try{ P.recordChildLog('APP_FATAL', (ev.message||'') + ' @ ' + (ev.lineno||0)); }catch(e){} });
    var ow = console.warn;
    console.warn = function(){ try{ P.recordChildLog('APP_WARN', Array.prototype.map.call(arguments, String).join(' ').slice(0,600)); }catch(e){} return ow.apply(console, arguments); };
    var g2 = null; try { g2 = !!document.createElement('canvas').getContext('webgl2'); } catch(e) {}
    try { P.recordChildLog('APP_ENV', JSON.stringify({secure: window.isSecureContext, webgpu: !!navigator.gpu, webgl2: g2, decompress: typeof DecompressionStream !== 'undefined'})); } catch(e) {}
  }
}catch(e){}})();
</script><style id="ios-island-shield">html,body{margin:0 !important;box-sizing:border-box !important;}</style>`;

function withBridge(bytes) {
  const text = new TextDecoder().decode(bytes);
  const m = /<head[^>]*>/i.exec(text);
  const out = m ? text.slice(0, m.index + m[0].length) + BRIDGE + text.slice(m.index + m[0].length) : BRIDGE + text;
  return new TextEncoder().encode(out);
}

function notFound(path) {
  return new Response('Not found in virtual server: ' + path, {
    status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

function respond(entry, key, request) {
  let bytes = fileBytes(entry, key);
  const type = mimeFor(key, entry.files[key].type);
  if (type.startsWith('text/html') && request.destination !== 'script') bytes = withBridge(bytes);
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin'
  };

  const range = request.headers.get('Range');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start = m[1] === '' ? Math.max(0, bytes.length - Number(m[2])) : Number(m[1]);
      let end = m[1] === '' || m[2] === '' ? bytes.length - 1 : Math.min(Number(m[2]), bytes.length - 1);
      if (start <= end && start < bytes.length) {
        return new Response(request.method === 'HEAD' ? null : bytes.slice(start, end + 1), {
          status: 206,
          headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': String(end - start + 1) }
        });
      }
    }
  }
  headers['Content-Length'] = String(bytes.length);
  return new Response(request.method === 'HEAD' ? null : bytes, { status: 200, headers });
}

async function handle(event) {
  const request = event.request;
  const url = new URL(request.url);
  const rest = url.pathname.slice(VFS_PREFIX.length);
  const slash = rest.indexOf('/');
  const id = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));
  if (slash === -1) {
    // /__vfs__/<id>  -> redirect to trailing slash so relative URLs resolve inside the app folder
    return Response.redirect(url.origin + VFS_PREFIX + encodeURIComponent(id) + '/' + url.search, 302);
  }

  let path = decodeURIComponent(rest.slice(slash + 1));
  const entry = await loadApp(id);
  if (!entry) return notFound(id);

  const entryName = (entry.app.entry || 'index.html').replace(/^\.?\//, '');
  if (path === '' || path.endsWith('/')) path += 'index.html';
  if (path === 'index.html' && !entry.index.has('index.html')) path = entryName;

  const lookup = path.replace(/^\.?\//, '').toLowerCase();
  let key = entry.index.get(lookup);

  // Folder URL without trailing slash, e.g. "docs" -> "docs/index.html"
  if (!key) key = entry.index.get(lookup + '/index.html');

  // Single-page-app fallback for navigations without a file extension
  if (!key && request.mode === 'navigate' && !/\.[a-z0-9]+$/i.test(lookup)) {
    key = entry.index.get(entryName.toLowerCase()) || entry.index.get('index.html');
  }

  if (!key) return notFound(path);
  return respond(entry, key, request);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(VFS_PREFIX)) return;
  event.respondWith(handle(event).catch((err) =>
    new Response('Virtual server error: ' + (err && err.message || err), { status: 500 })));
});
