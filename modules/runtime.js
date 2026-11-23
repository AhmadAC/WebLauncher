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
  assembleAndLoadApp(app);
}

export function assembleAndLoadApp(app) {
  cleanupActiveBlobs();
  const iframe = document.getElementById('runtime-iframe');
  iframe.removeAttribute('src');

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
  modal.style.display = 'none';
  iframe.srcdoc = '';
  iframe.src = 'about:blank';
  cleanupActiveBlobs();
  currentRunningApp = null;
  recordLog('APP_EXIT', 'Closed app runtime.');
}

export function reloadApp(showToast) {
  if (currentRunningApp) {
    assembleAndLoadApp(currentRunningApp);
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