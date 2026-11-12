// =========================================================================
// MAIN CONTROLLER: COORDINATION, SVG ICON PICKER & UI BINDINGS
// =========================================================================
import { initLogger, recordLog, downloadAppLogs } from './modules/logger.js';
import { initDatabase, loadAppsFromDB, saveAppToDB, deleteAppFromDB, clearAllAppsFromDB } from './modules/db.js';
import { readFileContent, parseZipBuffer, normalizeFileTree } from './modules/zip.js';
import { launchApp, exitApp, reloadApp, getExportableCode } from './modules/runtime.js';
import { setupFloatingMenu, collapseFloatingMenu } from './modules/floatingMenu.js';

const GRADIENTS = [
  "from-blue-600", "from-purple-600", "from-pink-600", "from-amber-500",
  "from-emerald-600", "from-cyan-500", "from-fuchsia-600", "from-red-600"
];

let apps = [];
let isEditMode = false;
let appBeingRenamedId = null;
let targetAppForIcon = null;

// Native BLE Bridge Initializer
window.BluetoothLe = window.Capacitor?.Plugins?.BluetoothLe || null;

export function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.innerText = msg;
  toast.style.display = 'block';
  setTimeout(() => toast.style.display = 'none', 2400);
}

export function openModal(id) {
  document.getElementById(id).style.display = 'flex';
}

export function closeModal(id) {
  document.getElementById(id).style.display = 'none';
}

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function triggerPicker(id) {
  closeModal('import-modal');
  const input = document.getElementById(id);
  input.value = '';
  input.click();
}

// =========================================================================
// SVG ICON PICKER & REPLACEMENT LOGIC FOR IPHONE
// =========================================================================
function openIconPickerForApp(appId) {
  targetAppForIcon = appId;
  const picker = document.getElementById('icon-picker');
  picker.value = '';
  picker.click();
}

async function handleIconPicked(event) {
  const file = event.target.files[0];
  if (!file || !targetAppForIcon) return;

  if (!file.name.toLowerCase().endsWith('.svg') && file.type !== 'image/svg+xml') {
    showToast("Please select a valid .svg file");
    return;
  }

  const reader = new FileReader();
  reader.onload = async (e) => {
    const rawSvg = e.target.result;
    // Encode to Data URL so it is clean, immutable and safely displayed in <img>
    const base64Svg = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(rawSvg)))}`;

    const target = apps.find(a => String(a.id) === String(targetAppForIcon));
    if (target) {
      target.icon = base64Svg;
      await saveAppToDB(target);
      await refreshApps();
      showToast(`Updated icon for "${target.name}"`);
      recordLog('ICON_UPDATED', `Custom SVG icon set for app: ${target.name} (${target.id})`);
    }
    targetAppForIcon = null;
  };
  reader.readAsText(file);
}

// =========================================================================
// RENDERING APP TILES
// =========================================================================
export function renderLauncher() {
  const grid = document.getElementById('app-grid');
  const emptyState = document.getElementById('empty-state');
  const counter = document.getElementById('app-counter');
  grid.innerHTML = '';

  counter.innerText = `${apps.length} App${apps.length === 1 ? '' : 's'}`;
  emptyState.style.display = apps.length === 0 ? 'flex' : 'none';

  apps.forEach((app) => {
    const appIdStr = escapeHtml(String(app.id));
    const tile = document.createElement('div');
    tile.style.cssText = "display:flex; flex-direction:column; align-items:center; position:relative; cursor:pointer;";

    tile.onclick = (e) => {
      if (e.target.closest('.edit-action-btn')) return;
      if (isEditMode) {
        // Tapping squircle directly in edit mode also triggers the SVG picker!
        openIconPickerForApp(app.id);
        return;
      }
      launchApp(app, showToast, collapseFloatingMenu);
    };

    const fileCount = app.files ? Object.keys(app.files).length : 1;
    const isMultiFile = fileCount > 1;

    // Render either the custom SVG or the fallback initial letter
    const iconGraphic = app.icon
      ? `<img src="${app.icon}" style="width:62%; height:62%; object-fit:contain; pointer-events:none;" alt="icon" />`
      : `<span style="font-size:1.6rem; font-weight:700; letter-spacing:-0.03em;">${escapeHtml(app.name.charAt(0).toUpperCase())}</span>`;

    tile.innerHTML = `
      <div class="relative ${isEditMode ? 'jiggle' : ''}" style="position:relative;">
        <button type="button" class="squircle ${app.gradient} app-press" style="width:68px; height:68px; display:flex; align-items:center; justify-content:center; color:white; border:none; box-shadow:0 8px 24px -4px rgba(0,0,0,0.6), inset 0 1px 1px rgba(255,255,255,0.25); cursor:pointer; pointer-events:none;">
          ${iconGraphic}
        </button>
        ${isMultiFile && !isEditMode ? `
          <div style="position:absolute; bottom:-3px; right:-3px; background:rgba(15,23,42,0.95); border:1px solid rgba(255,255,255,0.25); border-radius:9999px; padding:1px 5px; font-size:9px; font-weight:700; color:#38bdf8;">
            ${fileCount}f
          </div>
        ` : ''}
        ${isEditMode ? `
          <!-- Delete Button (Top-Right) -->
          <button type="button" data-delete-id="${appIdStr}" class="edit-action-btn" title="Delete App" style="position:absolute; top:-6px; right:-6px; width:22px; height:22px; border-radius:9999px; background:#FF453A; color:white; display:flex; align-items:center; justify-content:center; border:2px solid #090a10; z-index:30; cursor:pointer;">
            <svg style="width:12px; height:12px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>

          <!-- Rename Button (Top-Left) -->
          <button type="button" data-rename-id="${appIdStr}" class="edit-action-btn" title="Rename App" style="position:absolute; top:-6px; left:-6px; width:22px; height:22px; border-radius:9999px; background:#0A84FF; color:white; display:flex; align-items:center; justify-content:center; border:2px solid #090a10; z-index:30; cursor:pointer;">
            <svg style="width:11px; height:11px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
            </svg>
          </button>

          <!-- Export Single HTML (Bottom-Right) -->
          <button type="button" data-export-id="${appIdStr}" class="edit-action-btn" title="Export HTML File" style="position:absolute; bottom:-6px; right:-6px; width:22px; height:22px; border-radius:9999px; background:#30D158; color:white; display:flex; align-items:center; justify-content:center; border:2px solid #090a10; z-index:30; cursor:pointer;">
            <svg style="width:11px; height:11px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
          </button>

          <!-- Change SVG Icon Button (Bottom-Left) -->
          <button type="button" data-icon-id="${appIdStr}" class="edit-action-btn" title="Change SVG Icon" style="position:absolute; bottom:-6px; left:-6px; width:22px; height:22px; border-radius:9999px; background:#A855F7; color:white; display:flex; align-items:center; justify-content:center; border:2px solid #090a10; z-index:30; cursor:pointer;">
            <svg style="width:11px; height:11px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
            </svg>
          </button>
        ` : ''}
      </div>
      <span style="margin-top:8px; font-size:12px; font-weight:600; color:rgba(255,255,255,0.9); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; width:80px; text-align:center; pointer-events:none;">${escapeHtml(app.name)}</span>
    `;

    // Event Delegation bindings on Edit Actions
    tile.querySelectorAll('[data-delete-id]').forEach(b => b.onclick = (e) => removeApp(e, app.id));
    tile.querySelectorAll('[data-rename-id]').forEach(b => b.onclick = (e) => promptRenameApp(e, app.id));
    tile.querySelectorAll('[data-export-id]').forEach(b => b.onclick = (e) => exportSingleApp(e, app.id));
    tile.querySelectorAll('[data-icon-id]').forEach(b => b.onclick = (e) => { e.stopPropagation(); openIconPickerForApp(app.id); });

    grid.appendChild(tile);
  });

  if (!isEditMode) {
    const addTile = document.createElement('div');
    addTile.style.cssText = "display:flex; flex-direction:column; align-items:center; cursor:pointer;";
    addTile.onclick = () => openModal('import-modal');
    addTile.innerHTML = `
      <button type="button" class="squircle app-press" style="width:68px; height:68px; background:rgba(255,255,255,0.05); border:2px dashed rgba(255,255,255,0.2); display:flex; flex-direction:column; align-items:center; justify-content:center; color:rgba(255,255,255,0.4); cursor:pointer; pointer-events:none;">
        <svg style="width:24px; height:24px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
      </button>
      <span style="margin-top:8px; font-size:12px; font-weight:500; color:rgba(255,255,255,0.4); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; width:80px; text-align:center; pointer-events:none;">Add App</span>
    `;
    grid.appendChild(addTile);
  }
}

async function refreshApps() {
  apps = await loadAppsFromDB();
  renderLauncher();
}

// =========================================================================
// APP MANAGEMENT & IMPORT LOGIC
// =========================================================================
async function finalizeMultiFileApp(appFiles, fallbackName) {
  const fileKeys = Object.keys(appFiles);
  if (fileKeys.length === 0) {
    showToast("No usable files found.");
    return;
  }

  let entryName = fileKeys.find(k => k.toLowerCase() === 'index.html' || k.toLowerCase() === 'index.htm');
  if (!entryName) entryName = fileKeys.find(k => k.endsWith('.html') || k.endsWith('.htm')) || fileKeys[0];

  let finalName = fallbackName;
  if (appFiles[entryName] && !appFiles[entryName].isBinary) {
    const titleMatch = appFiles[entryName].content.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch && titleMatch[1].trim()) finalName = titleMatch[1].trim();
  }

  const newApp = {
    id: Date.now(),
    name: finalName,
    gradient: GRADIENTS[Math.floor(Math.random() * GRADIENTS.length)],
    entry: entryName,
    files: appFiles,
    code: appFiles[entryName] ? appFiles[entryName].content : '',
    icon: null,
    timestamp: Date.now()
  };

  await saveAppToDB(newApp);
  await refreshApps();
  recordLog('APP_SAVED', `Installed: "${finalName}" (${fileKeys.length} files)`);
  showToast(`Installed "${finalName}" (${fileKeys.length} files)!`);
}

async function removeApp(event, id) {
  event.stopPropagation();
  await deleteAppFromDB(id);
  await refreshApps();
  showToast("App deleted.");
}

function promptRenameApp(event, id) {
  event.stopPropagation();
  const targetApp = apps.find(a => String(a.id) === String(id));
  if (!targetApp) return;

  appBeingRenamedId = targetApp.id;
  const input = document.getElementById('rename-input');
  input.value = targetApp.name;
  openModal('rename-modal');
  setTimeout(() => input.focus(), 150);
}

async function saveRename() {
  const input = document.getElementById('rename-input');
  const newName = input.value.trim();
  if (!newName) {
    showToast("Name cannot be empty.");
    return;
  }
  const targetApp = apps.find(a => String(a.id) === String(appBeingRenamedId));
  if (targetApp) {
    targetApp.name = newName;
    await saveAppToDB(targetApp);
    await refreshApps();
    showToast("App renamed!");
  }
  closeModal('rename-modal');
}

async function exportSingleApp(event, id) {
  event.stopPropagation();
  const targetApp = apps.find(a => String(a.id) === String(id));
  if (!targetApp) return showToast("Could not find app to export.");

  const codeToExport = getExportableCode(targetApp);
  const safeFilename = `${targetApp.name.toLowerCase().replace(/[^a-z0-9_-]/gi, '_') || 'app'}.html`;

  if (navigator.share && navigator.canShare) {
    try {
      const file = new File([codeToExport], safeFilename, { type: 'text/html' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: targetApp.name });
        return showToast("Exported successfully!");
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }

  const blob = new Blob([codeToExport], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeFilename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`Saved "${safeFilename}"!`);
}

// Backup & Diagnostics
async function exportAllApps() {
  if (!apps || apps.length === 0) return showToast("No apps to export!");
  const filename = `weblauncher-backup-${new Date().toISOString().split('T')[0]}.json`;
  const backupData = {
    version: 2,
    source: "WebLauncher",
    exportedAt: new Date().toISOString(),
    totalApps: apps.length,
    apps: apps
  };

  const jsonStr = JSON.stringify(backupData, null, 2);
  if (navigator.share) {
    try {
      const file = new File([jsonStr], filename, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: "WebLauncher Backup" });
        closeModal('backup-modal');
        return showToast("Backup saved!");
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }

  navigator.clipboard.writeText(jsonStr).then(() => {
    showToast("Backup JSON copied to clipboard!");
  }).catch(() => showToast("Failed to export backup."));
}

function handleBackupSelected(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async function(e) {
    try {
      const parsed = JSON.parse(e.target.result);
      const importedApps = Array.isArray(parsed) ? parsed : (parsed.apps || []);
      if (!Array.isArray(importedApps) || importedApps.length === 0) {
        return showToast("No valid apps found in backup file.");
      }

      let restoredCount = 0;
      for (const item of importedApps) {
        if (item && item.name && (item.files || item.code)) {
          const appObj = {
            id: item.id || Date.now() + Math.floor(Math.random() * 1000),
            name: item.name,
            gradient: item.gradient || GRADIENTS[Math.floor(Math.random() * GRADIENTS.length)],
            entry: item.entry || 'index.html',
            files: item.files || { 'index.html': { content: item.code, isBinary: false, type: 'text/html' } },
            code: item.code || (item.files && item.files[item.entry || 'index.html']?.content) || '',
            icon: item.icon || null,
            timestamp: item.timestamp || Date.now()
          };
          await saveAppToDB(appObj);
          restoredCount++;
        }
      }
      await refreshApps();
      closeModal('backup-modal');
      showToast(`Restored ${restoredCount} apps!`);
    } catch (err) {
      showToast("Invalid backup JSON file.");
    }
  };
  reader.readAsText(file);
}

// =========================================================================
// INIT & EVENT LISTENERS
// =========================================================================
window.addEventListener('DOMContentLoaded', async () => {
  initLogger();
  setupFloatingMenu();
  await initDatabase();
  await refreshApps();

  // Top Nav Buttons
  document.getElementById('btn-download-logs').onclick = downloadAppLogs;
  document.getElementById('btn-open-backup').onclick = () => openModal('backup-modal');
  document.getElementById('btn-open-import').onclick = () => openModal('import-modal');
  document.getElementById('empty-import-btn').onclick = () => openModal('import-modal');
  document.getElementById('empty-restore-btn').onclick = () => triggerPicker('backup-picker');

  // Edit Mode Toggle
  const editBtn = document.getElementById('edit-toggle-btn');
  editBtn.onclick = () => {
    isEditMode = !isEditMode;
    editBtn.innerText = isEditMode ? 'Done' : 'Edit';
    editBtn.style.background = isEditMode ? '#0A84FF' : 'rgba(255,255,255,0.1)';
    renderLauncher();
  };

  // Modals Close Delegation
  document.querySelectorAll('.btn-close-modal').forEach(btn => {
    btn.onclick = () => closeModal(btn.getAttribute('data-target'));
  });

  // Modal Actions
  document.querySelectorAll('[data-picker]').forEach(btn => {
    btn.onclick = () => triggerPicker(btn.getAttribute('data-picker'));
  });
  document.getElementById('btn-save-rename').onclick = saveRename;
  document.getElementById('btn-save-crash-log').onclick = downloadAppLogs;
  document.getElementById('btn-export-all').onclick = exportAllApps;
  document.getElementById('btn-restore-backup').onclick = () => triggerPicker('backup-picker');
  document.getElementById('btn-wipe-all').onclick = async () => {
    if (confirm("Delete ALL apps? Make sure you exported a backup first.")) {
      await clearAllAppsFromDB();
      await refreshApps();
      closeModal('backup-modal');
      showToast("All apps deleted.");
    }
  };

  // Floating Menu Actions
  document.getElementById('btn-runtime-exit').onclick = exitApp;
  document.getElementById('btn-runtime-logs').onclick = downloadAppLogs;
  document.getElementById('btn-runtime-reload').onclick = () => reloadApp(showToast);
  document.getElementById('btn-runtime-collapse').onclick = collapseFloatingMenu;

  // File Inputs
  document.getElementById('icon-picker').onchange = handleIconPicked;
  document.getElementById('backup-picker').onchange = handleBackupSelected;
  document.getElementById('folder-picker').onchange = async (e) => {
    const list = Array.from(e.target.files);
    if (!list.length) return;
    const files = {};
    let appName = (list[0].webkitRelativePath || '').split('/')[0] || 'My App';
    for (const file of list) {
      if (file.name === '.DS_Store' || file.webkitRelativePath.includes('__MACOSX/')) continue;
      let rel = file.webkitRelativePath || file.name;
      if (rel.startsWith(appName + '/')) rel = rel.substring(appName.length + 1);
      files[rel] = await readFileContent(file);
    }
    await finalizeMultiFileApp(files, appName);
  };
  document.getElementById('multifile-picker').onchange = async (e) => {
    const list = Array.from(e.target.files);
    if (!list.length) return;
    if (list.length === 1 && (list[0].name.endsWith('.zip') || list[0].type.includes('zip'))) {
      const extracted = normalizeFileTree(await parseZipBuffer(await list[0].arrayBuffer()));
      return await finalizeMultiFileApp(extracted, list[0].name.replace(/\.[^/.]+$/, ""));
    }
    const files = {};
    for (const f of list) {
      if (f.name === '.DS_Store') continue;
      files[f.name] = await readFileContent(f);
    }
    await finalizeMultiFileApp(files, 'Robot App');
  };
  document.getElementById('zip-picker').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    showToast("Unpacking ZIP modules...");
    try {
      const extracted = normalizeFileTree(await parseZipBuffer(await file.arrayBuffer()));
      await finalizeMultiFileApp(extracted, file.name.replace(/\.[^/.]+$/, ""));
    } catch (err) {
      recordLog('ZIP_ERR', `Extraction failed: ${err.message}`);
      showToast("Error reading ZIP file.");
    }
  };
  document.getElementById('single-picker').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const content = await readFileContent(file);
    let appName = file.name.replace(/\.[^/.]+$/, "");
    const titleMatch = content.content.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch && titleMatch[1].trim()) appName = titleMatch[1].trim();
    await finalizeMultiFileApp({ 'index.html': content }, appName);
  };
});