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
      if (!window.BluetoothLe && window.parent && window.parent.BluetoothLe) {
        window.BluetoothLe = window.parent.BluetoothLe;
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

  // Legacy / Standalone Single-File Mode
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

  // Multi-File Virtual Module Resolution
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
    blobMap[relPath] = bUrl;
    blobMap['./' + relPath] = bUrl;
    blobMap['/' + relPath] = bUrl;

    if (relPath.endsWith('.js') || relPath.endsWith('.mjs')) {
      importMap.imports[relPath] = bUrl;
      importMap.imports['./' + relPath] = bUrl;
    }
  }

  const importMapTag = `<script type="importmap">${JSON.stringify(importMap)}<\/script>`;
  const entryKey = app.entry || 'index.html';
  const entryFile = app.files[entryKey] || Object.values(app.files)[0];
  let html = entryFile.content || '';

  // Inline CSS
  html = html.replace(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["'][^>]*>/gi, (match, href) => {
    const cleanHref = href.replace(/^\.\//, '');
    if (app.files[cleanHref] && !app.files[cleanHref].isBinary) {
      return `<style data-href="${cleanHref}">\n${app.files[cleanHref].content}\n</style>`;
    } else if (blobMap[href]) {
      return `<link rel="stylesheet" href="${blobMap[href]}">`;
    }
    return match;
  });

  // Rewrite Script Sources
  html = html.replace(/<script([^>]+)src=["']([^"']+)["']([^>]*)><\/script>/gi, (match, pre, src, post) => {
    if (blobMap[src]) {
      return `<script${pre}src="${blobMap[src]}"${post}><\/script>`;
    }
    return match;
  });

  // Rewrite Images, Audio and Media
  html = html.replace(/\b(src|href)=["']([^"']+)["']/gi, (match, attr, val) => {
    if (blobMap[val]) {
      return `${attr}="${blobMap[val]}"`;
    }
    return match;
  });

  // Inject Headers
  const injections = `\n${importMapTag}\n${bridgeScript}\n${islandShield}\n`;
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
    const cleanHref = href.replace(/^\.\//, '');
    if (targetApp.files[cleanHref] && !targetApp.files[cleanHref].isBinary) {
      return `<style data-source="${cleanHref}">\n${targetApp.files[cleanHref].content}\n</style>`;
    }
    return match;
  });

  html = html.replace(/<script([^>]+)src=["']([^"']+)["']([^>]*)><\/script>/gi, (match, pre, src, post) => {
    const cleanSrc = src.replace(/^\.\//, '');
    if (targetApp.files[cleanSrc] && !targetApp.files[cleanSrc].isBinary && !pre.includes('type="module"')) {
      return `<script${pre}${post}>\n${targetApp.files[cleanSrc].content}\n<\/script>`;
    }
    return match;
  });

  return html;
}