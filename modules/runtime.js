// =========================================================================
// RUNTIME ENGINE: VIRTUAL BUNDLER, CAPACITOR BRIDGE & EXPORT BUILDER
// =========================================================================
import { recordLog } from './logger.js';

let activeBlobUrls = [];
let currentRunningApp = null;

export function getCurrentRunningApp() {
  return currentRunningApp;
}

export function cleanupActiveBlobs() {
  if (activeBlobUrls && activeBlobUrls.length > 0) {
    activeBlobUrls.forEach(url => URL.revokeObjectURL(url));
    activeBlobUrls = [];
  }
}

// -------------------------------------------------------------------------
// VIRTUAL LOCAL SERVER (service worker, see /sw.js)
// -------------------------------------------------------------------------
let vfsReady = null;

export function registerVirtualServer() {
  if (vfsReady) return vfsReady;
  const secure = window.isSecureContext && /^https?:$/.test(location.protocol);
  if (!navigator.serviceWorker || !secure) {
    vfsReady = Promise.resolve(null);
    return vfsReady;
  }
  vfsReady = navigator.serviceWorker
    .register('sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then((reg) => {
      recordLog('VFS_READY', 'Virtual server active, scope: ' + reg.scope);
      return reg;
    })
    .catch((err) => {
      recordLog('VFS_ERR', 'Service worker registration failed: ' + (err && err.message || err));
      return null;
    });
  return vfsReady;
}

async function tryLaunchViaVirtualServer(app, iframe) {
  const reg = await registerVirtualServer();
  if (!reg || !reg.active) return false;
  // Wait until this page is controlled so the first iframe request is intercepted reliably
  reg.active.postMessage({ type: 'vfs-clear', id: String(app.id) });

  const entry = (app.entry || 'index.html').replace(/^\.?\//, '');
  const base = new URL('__vfs__/' + encodeURIComponent(String(app.id)) + '/', reg.scope);
  const url = base.href + entry.split('/').map(encodeURIComponent).join('/');

  // Probe first: if the worker is not answering yet, fall back instead of showing a blank frame
  try {
    const probe = await fetch(url, { cache: 'no-store' });
    if (!probe.ok) throw new Error('HTTP ' + probe.status);
  } catch (err) {
    recordLog('VFS_ERR', 'Probe failed for ' + url + ': ' + (err && err.message || err));
    return false;
  }
  iframe.removeAttribute('srcdoc');
  iframe.src = url;
  recordLog('VFS_LAUNCH', 'Serving ' + app.name + ' from ' + url);
  return true;
}

// -------------------------------------------------------------------------
// NATIVE LOCAL SERVER (iOS app: plugins/capacitor-smb/LocalServerPlugin.swift)
// WKWebView has no service workers, so the iOS app serves imported apps from a
// loopback HTTP server written in Swift and loads them from http://127.0.0.1:<port>/
// -------------------------------------------------------------------------
function getNativeServer() {
  const cap = window.Capacitor;
  const isNative = cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform();
  return isNative && cap.Plugins && cap.Plugins.LocalServer ? cap.Plugins.LocalServer : null;
}

// Apps that need a real http origin (wasm, ES modules, workers). Override per app with app.useServer = true/false.
function needsRealServer(app) {
  if (app.useServer === true) return true;
  if (app.useServer === false) return false;
  const names = Object.keys(app.files || {});
  if (names.some(n => /\.(wasm|mjs)$/i.test(n))) return true;
  const entry = app.files[app.entry || 'index.html'];
  const html = entry && !entry.isBinary ? entry.content || '' : '';
  return /type\s*=\s*["']module["']/i.test(html) || /new\s+Worker\s*\(/i.test(html);
}

function bytesToBase64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(s);
}

async function writeFileToNative(LS, id, path, fileObj) {
  if (fileObj.isBinary) {
    const b64 = fileObj.content || '';
    const CH = 1048576; // chars, multiple of 4 so every chunk decodes on its own
    if (!b64.length) { await LS.writeFile({ id, path, data: '', append: false }); return; }
    for (let off = 0; off < b64.length; off += CH) {
      await LS.writeFile({ id, path, data: b64.slice(off, off + CH), append: off > 0 });
    }
  } else {
    const bytes = new TextEncoder().encode(fileObj.content || '');
    const CH = 786432; // bytes, multiple of 3
    if (!bytes.length) { await LS.writeFile({ id, path, data: '', append: false }); return; }
    for (let off = 0; off < bytes.length; off += CH) {
      await LS.writeFile({ id, path, data: bytesToBase64(bytes.subarray(off, off + CH)), append: off > 0 });
    }
  }
}

async function tryLaunchViaNativeServer(app, iframe, showToast) {
  const LS = getNativeServer();
  if (!LS) return false;
  try {
    const id = String(app.id).replace(/[^A-Za-z0-9_-]/g, '_');
    const { port } = await LS.start();
    const version = String(app.timestamp || app.id) + ':' + Object.keys(app.files).length;
    let have = {};
    try { have = await LS.getVersion({ id }); } catch (e) {}
    if (have.version !== version) {
      if (showToast) showToast('Preparing app files...');
      await LS.clearApp({ id });
      for (const [rel, f] of Object.entries(app.files)) {
        await writeFileToNative(LS, id, rel.replace(/^\.?\//, ''), f);
      }
      await LS.finish({ id, version });
    }
    const entry = (app.entry || 'index.html').replace(/^\.?\//, '');
    const url = `http://127.0.0.1:${port}/${id}/` + entry.split('/').map(encodeURIComponent).join('/');
    iframe.removeAttribute('srcdoc');
    iframe.src = url;
    recordLog('NATIVE_SRV_LAUNCH', 'Serving ' + app.name + ' from ' + url);
    return true;
  } catch (err) {
    recordLog('NATIVE_SRV_ERR', (err && err.message) || String(err));
    return false;
  }
}

// Errors from apps served by the native server arrive as postMessage (different origin than the launcher)
window.addEventListener('message', (ev) => {
  const d = ev.data;
  if (!d || !d.__weblauncher) return;
  const f = document.getElementById('runtime-iframe');
  if (f && ev.source === f.contentWindow) recordLog(String(d.level || 'APP'), String(d.msg || ''));
});

export function launchApp(app, showToast, collapseFloatingMenu) {
  if (!app || (!app.code && !app.files)) {
    showToast("App files are empty.");
    return;
  }
  currentRunningApp = app;
  recordLog('APP_LAUNCH', `Launching: ${app.name} (ID: ${app.id})`);

  const modal = document.getElementById('runtime-modal');
  collapseFloatingMenu();

  modal.style.display = 'flex';
  assembleAndLoadApp(app, showToast);
}

export function assembleAndLoadApp(app, showToast) {
  cleanupActiveBlobs();
  const iframe = document.getElementById('runtime-iframe');
  iframe.removeAttribute('src');

  // Multi-file apps (zips, folders, WebAssembly) run on the virtual local server when available
  if (app.files && Object.keys(app.files).length > 1) {
    const token = Symbol('launch');
    assembleAndLoadApp.token = token;
    (async () => {
      let ok = false;
      if (needsRealServer(app)) ok = await tryLaunchViaNativeServer(app, iframe, showToast);
      if (!ok) ok = await tryLaunchViaVirtualServer(app, iframe);
      if (assembleAndLoadApp.token !== token) {   // user exited / relaunched meanwhile
        if (ok) iframe.src = 'about:blank';
        return;
      }
      if (ok) return;
      if (showToast) {
        showToast('No local server available here - using basic mode (some apps may not run).');
      }
      assembleBundledApp(app, iframe);
    })();
    return;
  }
  assembleBundledApp(app, iframe);
}

// Fallback: single file apps, or when service workers are unavailable (file://, iOS WebView)
function assembleBundledApp(app, iframe) {

  const bridgeScript = `
    <script id="native-runtime-bridge">
      if (!window.Capacitor && window.parent && window.parent.Capacitor) {
        window.Capacitor = window.parent.Capacitor;
      }
      if (window.Capacitor && window.parent && window.parent.Capacitor && window.parent.Capacitor.Plugins) {
        window.Capacitor.Plugins = window.Capacitor.Plugins || {};
        for (const [pluginName, pluginInstance] of Object.entries(window.parent.Capacitor.Plugins)) {
          if (!window.Capacitor.Plugins[pluginName]) {
            window.Capacitor.Plugins[pluginName] = pluginInstance;
          }
        }
      }
      if (!window.BluetoothLe && window.parent) {
        window.BluetoothLe = window.parent.BluetoothLe || window.parent.Capacitor?.Plugins?.BluetoothLe || null;
      }
      if (!window.Smb && window.parent) {
        window.Smb = window.parent.Smb || window.parent.Capacitor?.Plugins?.Smb || null;
      }
      if (!window.TextToSpeech && window.parent) {
        window.TextToSpeech = window.parent.TextToSpeech || window.parent.Capacitor?.Plugins?.TextToSpeech || null;
      }
      if (window.parent && window.parent.recordChildLog) {
        window.recordChildLog = window.parent.recordChildLog;
        const _origErr = console.error;
        console.error = function(...args) {
          try { window.parent.recordChildLog('APP_ERR', args.map(a => String(a)).join(' ')); } catch (e) {}
          return _origErr.apply(console, args);
        };
        window.addEventListener('error', function(ev) {
          try { window.parent.recordChildLog('APP_FATAL', (ev.message || '') + ' @ ' + (ev.lineno || 0)); } catch (e) {}
        });
      }
    <\/script>
  `;

  const islandShield = `
    <style id="ios-island-shield">
      html, body {
        margin: 0 !important;
        box-sizing: border-box !important;
      }
    </style>
  `;

  // Standalone Single-File Mode
  if (!app.files || Object.keys(app.files).length <= 1) {
    let code = app.code || (app.files && Object.values(app.files)[0]?.content) || '';
    if (code.includes('<head>')) {
      code = code.replace('<head>', '<head>\n' + bridgeScript + '\n' + islandShield);
    } else {
      code = bridgeScript + islandShield + code;
    }
    iframe.srcdoc = code;
    return;
  }

  // Multi-File & WASM Virtual Module Resolution
  const blobMap = {};
  const importMap = { imports: {} };

  for (const [relPath, fileObj] of Object.entries(app.files)) {
    let blob;
    if (fileObj.isBinary) {
      const binStr = atob(fileObj.content);
      const bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
      blob = new Blob([bytes], { type: fileObj.type });
    } else {
      blob = new Blob([fileObj.content], { type: fileObj.type });
    }

    const bUrl = URL.createObjectURL(blob);
    activeBlobUrls.push(bUrl);

    const cleanPath = relPath.replace(/^\.\//, '').replace(/^\//, '');
    blobMap[cleanPath] = bUrl;
    blobMap['./' + cleanPath] = bUrl;
    blobMap['/' + cleanPath] = bUrl;

    if (cleanPath.endsWith('.js') || cleanPath.endsWith('.mjs')) {
      importMap.imports[cleanPath] = bUrl;
      importMap.imports['./' + cleanPath] = bUrl;
      importMap.imports['/' + cleanPath] = bUrl;
    }
  }

  // Intercept fetch and WebAssembly.instantiateStreaming so Wasm and snippets load from blobMap
  const wasmFetchInterceptor = `
    <script id="wasm-fetch-interceptor">
      (function() {
        const vfs = ${JSON.stringify(blobMap)};
        const origFetch = window.fetch;
        window.fetch = function(resource, init) {
          let url = typeof resource === 'string' ? resource : (resource && resource.url ? resource.url : '');
          url = url.replace(window.location.origin, '').replace(/^about:srcdoc\\/?/, '').replace(/^\\.\\//, '').replace(/^\\//, '');
          if (vfs[url]) {
            return origFetch(vfs[url], init);
          }
          if (vfs['./' + url]) {
            return origFetch(vfs['./' + url], init);
          }
          return origFetch(resource, init);
        };

        if (window.WebAssembly && window.WebAssembly.instantiateStreaming) {
          const origInstantiateStreaming = window.WebAssembly.instantiateStreaming;
          window.WebAssembly.instantiateStreaming = async function(respPromise, importObject) {
            try {
              const resp = await respPromise;
              const source = await resp.arrayBuffer();
              return await WebAssembly.instantiate(source, importObject);
            } catch (err) {
              return origInstantiateStreaming(respPromise, importObject);
            }
          };
        }
      })();
    <\/script>
  `;

  const importMapTag = `<script type="importmap">${JSON.stringify(importMap)}<\/script>`;
  const entryKey = app.entry || 'index.html';
  const entryFile = app.files[entryKey] || Object.values(app.files)[0];
  let html = entryFile.content || '';

  // Inline / rewrite CSS
  html = html.replace(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["'][^>]*>/gi, (match, href) => {
    const cleanHref = href.replace(/^\.\//, '').replace(/^\//, '');
    if (app.files[cleanHref] && !app.files[cleanHref].isBinary) {
      return `<style data-href="${cleanHref}">\n${app.files[cleanHref].content}\n</style>`;
    } else if (blobMap[cleanHref]) {
      return `<link rel="stylesheet" href="${blobMap[cleanHref]}">`;
    }
    return match;
  });

  // Rewrite Preload links (Trunk wasm-bindgen uses <link rel="preload" href="...wasm" as="fetch">)
  html = html.replace(/<link([^>]+)href=["']([^"']+)["']([^>]*)>/gi, (match, pre, href, post) => {
    const cleanHref = href.replace(/^\.\//, '').replace(/^\//, '');
    if (blobMap[cleanHref]) {
      return `<link${pre}href="${blobMap[cleanHref]}"${post}>`;
    }
    return match;
  });

  // Rewrite Script Sources
  html = html.replace(/<script([^>]+)src=["']([^"']+)["']([^>]*)><\/script>/gi, (match, pre, src, post) => {
    const cleanSrc = src.replace(/^\.\//, '').replace(/^\//, '');
    if (blobMap[cleanSrc]) {
      return `<script${pre}src="${blobMap[cleanSrc]}"${post}><\/script>`;
    }
    return match;
  });

  // Rewrite Media (Images, Icons)
  html = html.replace(/\b(src|href)=["']([^"']+)["']/gi, (match, attr, val) => {
    const cleanVal = val.replace(/^\.\//, '').replace(/^\//, '');
    if (blobMap[cleanVal]) {
      return `${attr}="${blobMap[cleanVal]}"`;
    }
    return match;
  });

  // Inject interceptor and bridges into head
  const injections = `\n${importMapTag}\n${wasmFetchInterceptor}\n${bridgeScript}\n${islandShield}\n`;
  if (html.includes('<head>')) {
    html = html.replace('<head>', '<head>' + injections);
  } else {
    html = injections + html;
  }

  iframe.srcdoc = html;
}

export function exitApp() {
  const modal = document.getElementById('runtime-modal');
  const iframe = document.getElementById('runtime-iframe');
  assembleAndLoadApp.token = null;
  modal.style.display = 'none';
  iframe.srcdoc = '';
  iframe.src = 'about:blank';
  cleanupActiveBlobs();
  currentRunningApp = null;
  recordLog('APP_EXIT', 'Closed app runtime.');
}

export function reloadApp(showToast) {
  if (currentRunningApp) {
    assembleAndLoadApp(currentRunningApp, showToast);
    showToast("App reloaded");
    recordLog('APP_RELOAD', `Reloaded: ${currentRunningApp.name}`);
  }
}

export function getExportableCode(targetApp) {
  if (!targetApp.files || Object.keys(targetApp.files).length <= 1) {
    return targetApp.code || (targetApp.files && Object.values(targetApp.files)[0]?.content) || '';
  }

  const entryKey = targetApp.entry || 'index.html';
  const entryFile = targetApp.files[entryKey] || Object.values(targetApp.files)[0];
  let html = entryFile.content || '';

  html = html.replace(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["'][^>]*>/gi, (match, href) => {
    const cleanHref = href.replace(/^\.\//, '').replace(/^\//, '');
    if (targetApp.files[cleanHref] && !targetApp.files[cleanHref].isBinary) {
      return `<style data-source="${cleanHref}">\n${targetApp.files[cleanHref].content}\n</style>`;
    }
    return match;
  });

  html = html.replace(/<script([^>]+)src=["']([^"']+)["']([^>]*)><\/script>/gi, (match, pre, src, post) => {
    const cleanSrc = src.replace(/^\.\//, '').replace(/^\//, '');
    if (targetApp.files[cleanSrc] && !targetApp.files[cleanSrc].isBinary && !pre.includes('type="module"')) {
      return `<script${pre}${post}>\n${targetApp.files[cleanSrc].content}\n<\/script>`;
    }
    return match;
  });

  return html;
}
