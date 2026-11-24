// =========================================================================
// MAIN CONTROLLER: COORDINATION, SVG ICON PICKER & UI BINDINGS
// =========================================================================
import { initLogger, recordLog, downloadAppLogs } from './modules/logger.js';
import { initDatabase, loadAppsFromDB, saveAppToDB, saveAppsToDB, deleteAppFromDB, clearAllAppsFromDB } from './modules/db.js';
import { readFileContent, parseZipBuffer, normalizeFileTree } from './modules/zip.js';
import { launchApp, exitApp, reloadApp, getExportableCode, registerVirtualServer, cycleLaunchMode } from './modules/runtime.js';
import { shortcutUrl, liveContainerUrl, getLcBundle, setLcBundle, buildWebClip, renderIconPng, listenForShortcuts } from './modules/shortcuts.js';
import { setupFloatingMenu, collapseFloatingMenu } from './modules/floatingMenu.js';

// Gradient presets. The keys match the legacy CSS class names that older saved apps
// store in `app.gradient`, so existing apps keep their colour.
const GRADIENT_DEFS = {
  "from-blue-600":    ["#2563eb", "#4338ca"],
  "from-purple-600":  ["#9333ea", "#4f46e5"],
  "from-pink-600":    ["#db2777", "#e11d48"],
  "from-amber-500":   ["#f59e0b", "#ea580c"],
  "from-emerald-600": ["#059669", "#0f766e"],
  "from-cyan-500":    ["#06b6d4", "#2563eb"],
  "from-fuchsia-600": ["#c026d3", "#db2777"],
  "from-red-600":     ["#dc2626", "#be123c"]
};
const GRADIENTS = Object.keys(GRADIENT_DEFS);

const SOLID_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#3b82f6",
  "#6366f1", "#a855f7", "#ec4899", "#64748b", "#ffffff", "#111827"
];

let apps = [];
let isEditMode = false;
let appBeingRenamedId = null;
let targetAppForIcon = null;
let searchQuery = '';
let suppressClickUntil = 0;

// =========================================================================
// NATIVE PLUGINS & BRIDGES (BLE, SMB, TEXT-TO-SPEECH)
// =========================================================================
export function getNativeTTS() {
  if (window.Capacitor?.Plugins?.TextToSpeech) {
    return window.Capacitor.Plugins.TextToSpeech;
  }
  if (window.TextToSpeech) {
    return window.TextToSpeech;
  }
  return null;
}

export function syncNativePlugins() {
  if (window.Capacitor?.Plugins) {
    if (window.Capacitor.Plugins.BluetoothLe) {
      window.BluetoothLe = window.Capacitor.Plugins.BluetoothLe;
    }
    if (window.Capacitor.Plugins.Smb) {
      window.Smb = window.Capacitor.Plugins.Smb;
    }
    if (window.Capacitor.Plugins.TextToSpeech) {
      window.TextToSpeech = window.Capacitor.Plugins.TextToSpeech;
    }
  } else {
    window.BluetoothLe = window.BluetoothLe || null;
    window.Smb = window.Smb || null;
    window.TextToSpeech = window.TextToSpeech || null;
  }
}

syncNativePlugins();
registerVirtualServer();

export function showToast(msg) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.innerText = msg;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 2400);
}

export function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.style.display = 'flex';
}

export function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.style.display = 'none';
  if (id === 'style-modal') onStyleModalClosed();
}

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function triggerPicker(id) {
  closeModal('import-modal');
  const input = document.getElementById(id);
  if (input) {
    input.value = '';
    input.click();
  }
}

function getScrollerEl() {
  return document.getElementById('app-scroller') || document.querySelector('main') || document.documentElement;
}

// =========================================================================
// SVG ICON PICKER & REPLACEMENT LOGIC FOR IPHONE
// =========================================================================
function openIconPickerForApp(appId) {
  targetAppForIcon = appId;
  const picker = document.getElementById('icon-picker');
  if (picker) {
    picker.value = '';
    picker.click();
  }
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
// TILE STYLE HELPERS (colour / opacity / transparent / glass)
// =========================================================================
const TILE_MODES = ['gradient', 'color', 'transparent', 'glass'];

function hexToRgb(hex) {
  let h = String(hex || '').trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function normalizeHex(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  return '#' + rgb.map(n => n.toString(16).padStart(2, '0')).join('');
}

function rgbaStr(hex, alpha) {
  const [r, g, b] = hexToRgb(hex) || [37, 99, 235];
  return `rgba(${r},${g},${b},${alpha})`;
}

function isLightColor(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return false;
  return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 > 0.62;
}

// Always returns a complete, valid style. Apps that were installed before this
// feature existed have no `tileStyle`, so they fall back to their old gradient.
function resolveTileStyle(app) {
  const s = app.tileStyle || {};
  const mode = TILE_MODES.includes(s.mode) ? s.mode : 'gradient';
  const gradient = GRADIENT_DEFS[s.gradient] ? s.gradient
    : (GRADIENT_DEFS[app.gradient] ? app.gradient : GRADIENTS[0]);
  const color = normalizeHex(s.color) || '#2563eb';
  let opacity = s.opacity == null ? 100 : Number(s.opacity);
  if (!Number.isFinite(opacity)) opacity = 100;
  opacity = Math.min(100, Math.max(0, Math.round(opacity)));
  return { mode, gradient, color, opacity };
}

// Inline CSS for the 68x68 tile face.
function tileFaceStyle(app) {
  const s = resolveTileStyle(app);
  const a = s.opacity / 100;
  const dropShadow = (k) => `0 8px 24px -4px rgba(0,0,0,${(0.6 * k).toFixed(2)})`;
  const highlight = (k) => `inset 0 1px 1px rgba(255,255,255,${(0.25 * k).toFixed(2)})`;
  let background, border = 'none', shadow, extra = '', text = '#ffffff', textShadow = 'none';

  if (s.mode === 'transparent') {
    background = 'transparent';
    shadow = 'none';
    textShadow = '0 1px 6px rgba(0,0,0,0.75)';
  } else if (s.mode === 'glass') {
    background = 'rgba(255,255,255,0.12)';
    border = '1px solid rgba(255,255,255,0.28)';
    shadow = `${dropShadow(0.7)}, ${highlight(1.2)}`;
    extra = 'backdrop-filter:blur(14px) saturate(160%); -webkit-backdrop-filter:blur(14px) saturate(160%);';
  } else if (s.mode === 'color') {
    background = rgbaStr(s.color, a);
    shadow = `${dropShadow(a)}, ${highlight(a)}`;
    if (a > 0.5 && isLightColor(s.color)) text = '#0f172a';
  } else {
    const [c1, c2] = GRADIENT_DEFS[s.gradient];
    background = `linear-gradient(135deg, ${rgbaStr(c1, a)}, ${rgbaStr(c2, a)})`;
    shadow = `${dropShadow(a)}, ${highlight(a)}`;
  }

  return `width:68px; height:68px; display:flex; align-items:center; justify-content:center; ` +
    `color:${text}; text-shadow:${textShadow}; background:${background}; border:${border}; ` +
    `box-shadow:${shadow}; ${extra} cursor:pointer; pointer-events:none;`;
}

function iconMarkup(app) {
  return app.icon
    ? `<img src="${app.icon}" style="width:62%; height:62%; object-fit:contain; pointer-events:none;" alt="icon" />`
    : `<span style="font-size:1.6rem; font-weight:700; letter-spacing:-0.03em;">${escapeHtml(String(app.name || '?').charAt(0).toUpperCase())}</span>`;
}

function findApp(id) {
  return apps.find(a => String(a.id) === String(id));
}

function findTileEl(id) {
  const grid = document.getElementById('app-grid');
  if (!grid) return null;
  return Array.from(grid.children).find(el => el.dataset && el.dataset.appId === String(id));
}

function refreshTileFace(app) {
  const tile = findTileEl(app.id);
  const face = tile && tile.querySelector('.tile-face');
  if (face) face.style.cssText = tileFaceStyle(app);
}

// =========================================================================
// SEARCH
// =========================================================================
function getVisibleApps() {
  const words = searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return apps;
  return apps.filter(app => {
    const name = String(app.name || '').toLowerCase();
    return words.every(w => name.includes(w));
  });
}

function setSearch(value) {
  searchQuery = value;
  const clear = document.getElementById('search-clear');
  if (clear) clear.style.display = value ? 'flex' : 'none';
  renderLauncher();
}

function initSearch() {
  const input = document.getElementById('search-input');
  const clear = document.getElementById('search-clear');
  if (!input) return;

  input.addEventListener('input', () => setSearch(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = getVisibleApps()[0];
      input.blur();
      if (first && searchQuery.trim() && !isEditMode) {
        launchApp(first, showToast, collapseFloatingMenu);
      }
    } else if (e.key === 'Escape') {
      input.value = '';
      setSearch('');
    }
  });

  if (clear) {
    clear.onclick = () => {
      input.value = '';
      setSearch('');
      input.focus();
    };
  }
}

// =========================================================================
// RENDERING APP TILES
// =========================================================================
export function renderLauncher() {
  const grid = document.getElementById('app-grid');
  const emptyState = document.getElementById('empty-state');
  const noResults = document.getElementById('no-results');
  const counter = document.getElementById('app-counter');
  if (!grid) return;
  grid.innerHTML = '';

  const query = searchQuery.trim();
  const visible = getVisibleApps();
  const plural = apps.length === 1 ? '' : 's';

  if (counter) {
    counter.innerText = query
      ? `${visible.length} of ${apps.length}`
      : `${apps.length} App${plural}`;
  }

  if (emptyState) {
    emptyState.style.display = apps.length === 0 ? 'flex' : 'none';
  }

  const showNoResults = apps.length > 0 && visible.length === 0;
  if (noResults) {
    noResults.style.display = showNoResults ? 'flex' : 'none';
    const noResultsQuery = document.getElementById('no-results-query');
    if (noResultsQuery && showNoResults) {
      noResultsQuery.textContent = `Nothing matches "${query}"`;
    }
  }

  visible.forEach((app) => {
    const appIdStr = escapeHtml(String(app.id));
    const tile = document.createElement('div');
    tile.className = 'app-tile';
    tile.dataset.appId = String(app.id);
    tile.style.cssText = "display:flex; flex-direction:column; align-items:center; position:relative; cursor:pointer;";

    tile.onclick = (e) => {
      if (Date.now() < suppressClickUntil) return;
      if (e.target.closest('.edit-action-btn')) return;
      if (isEditMode) {
        openStyleModal(app.id);
        return;
      }
      launchApp(app, showToast, collapseFloatingMenu);
    };

    const fileCount = app.files ? Object.keys(app.files).length : 1;
    const isMultiFile = fileCount > 1;

    tile.innerHTML = `
      <div class="relative ${isEditMode ? 'jiggle' : ''}" style="position:relative;">
        <button type="button" class="squircle app-press tile-face">
          ${iconMarkup(app)}
        </button>
        ${isMultiFile && !isEditMode ? `
          <div style="position:absolute; bottom:-3px; right:-3px; background:rgba(15,23,42,0.95); border:1px solid rgba(255,255,255,0.25); border-radius:9999px; padding:1px 5px; font-size:9px; font-weight:700; color:#38bdf8;">
            ${fileCount}f
          </div>
        ` : ''}
        ${isEditMode ? `
          <!-- Delete Button -->
          <button type="button" data-delete-id="${appIdStr}" class="edit-action-btn" title="Delete App" style="position:absolute; top:-6px; right:-6px; width:22px; height:22px; border-radius:9999px; background:#FF453A; color:white; display:flex; align-items:center; justify-content:center; border:2px solid #090a10; z-index:30; cursor:pointer;">
            <svg style="width:12px; height:12px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>

          <!-- Rename Button -->
          <button type="button" data-rename-id="${appIdStr}" class="edit-action-btn" title="Rename App" style="position:absolute; top:-6px; left:-6px; width:22px; height:22px; border-radius:9999px; background:#0A84FF; color:white; display:flex; align-items:center; justify-content:center; border:2px solid #090a10; z-index:30; cursor:pointer;">
            <svg style="width:11px; height:11px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
            </svg>
          </button>

          <!-- Export Single HTML -->
          <button type="button" data-export-id="${appIdStr}" class="edit-action-btn" title="Export HTML File" style="position:absolute; bottom:-6px; right:-6px; width:22px; height:22px; border-radius:9999px; background:#30D158; color:white; display:flex; align-items:center; justify-content:center; border:2px solid #090a10; z-index:30; cursor:pointer;">
            <svg style="width:11px; height:11px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
          </button>

          <!-- Change SVG Icon Button -->
          <button type="button" data-icon-id="${appIdStr}" class="edit-action-btn" title="Change SVG Icon" style="position:absolute; bottom:-6px; left:-6px; width:22px; height:22px; border-radius:9999px; background:#A855F7; color:white; display:flex; align-items:center; justify-content:center; border:2px solid #090a10; z-index:30; cursor:pointer;">
            <svg style="width:11px; height:11px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
            </svg>
          </button>
        ` : ''}
      </div>
      <span style="margin-top:8px; font-size:12px; font-weight:600; color:rgba(255,255,255,0.9); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; width:80px; text-align:center; pointer-events:none;">${escapeHtml(app.name)}</span>
    `;

    const face = tile.querySelector('.tile-face');
    if (face) face.style.cssText = tileFaceStyle(app);

    tile.querySelectorAll('[data-delete-id]').forEach(b => b.onclick = (e) => removeApp(e, app.id));
    tile.querySelectorAll('[data-rename-id]').forEach(b => b.onclick = (e) => promptRenameApp(e, app.id));
    tile.querySelectorAll('[data-export-id]').forEach(b => b.onclick = (e) => exportSingleApp(e, app.id));
    tile.querySelectorAll('[data-icon-id]').forEach(b => b.onclick = (e) => { e.stopPropagation(); openIconPickerForApp(app.id); });

    if (isEditMode) attachDrag(tile);

    grid.appendChild(tile);
  });

  if (!isEditMode && !query) {
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

// =========================================================================
// HOME-SCREEN ORDER
// =========================================================================
function nextOrder() {
  return apps.reduce((max, a) => Math.max(max, Number.isFinite(a.order) ? a.order : -1), -1) + 1;
}

async function normalizeOrder() {
  apps.sort((a, b) => {
    const ao = Number.isFinite(a.order) ? a.order : Infinity;
    const bo = Number.isFinite(b.order) ? b.order : Infinity;
    if (ao !== bo) return ao < bo ? -1 : 1;
    return (Number(a.timestamp) || Number(a.id) || 0) - (Number(b.timestamp) || Number(b.id) || 0);
  });
  const changed = [];
  apps.forEach((app, i) => {
    if (app.order !== i) {
      app.order = i;
      changed.push(app);
    }
  });
  if (changed.length) {
    try {
      await saveAppsToDB(changed);
    } catch (err) {
      recordLog('ORDER_ERR', `Could not save app order: ${err}`);
    }
  }
}

async function refreshApps() {
  apps = await loadAppsFromDB();
  await normalizeOrder();
  renderLauncher();
}

// =========================================================================
// TILE STYLE EDITOR (background colour, transparent, glass, opacity)
// =========================================================================
let styleTargetId = null;
let styleDirty = false;
let styleSaveTimer = null;
let styleSwatchesBuilt = false;

function makeSwatch(container, { mode, value, bg, title, className }) {
  if (!container) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'swatch' + (className ? ' ' + className : '');
  b.title = title;
  b.setAttribute('aria-label', title);
  b.dataset.mode = mode;
  if (value) b.dataset.value = value;
  if (bg) b.style.background = bg;
  b.onclick = () => {
    if (mode === 'gradient') updateTileStyle({ mode, gradient: value });
    else if (mode === 'color') updateTileStyle({ mode, color: value });
    else updateTileStyle({ mode });
  };
  container.appendChild(b);
}

function buildStyleSwatches() {
  if (styleSwatchesBuilt) return;
  styleSwatchesBuilt = true;

  const special = document.getElementById('swatches-special');
  makeSwatch(special, { mode: 'transparent', title: 'Transparent', className: 'swatch-checker' });
  makeSwatch(special, {
    mode: 'glass', title: 'Frosted glass',
    bg: 'linear-gradient(135deg, rgba(255,255,255,0.45), rgba(255,255,255,0.08))'
  });

  const grad = document.getElementById('swatches-gradient');
  GRADIENTS.forEach(name => {
    const [c1, c2] = GRADIENT_DEFS[name];
    makeSwatch(grad, { mode: 'gradient', value: name, title: name.replace('from-', '').replace(/-\d+$/, ''), bg: `linear-gradient(135deg, ${c1}, ${c2})` });
  });

  const colors = document.getElementById('swatches-color');
  SOLID_COLORS.forEach(hex => {
    makeSwatch(colors, { mode: 'color', value: hex, title: hex, bg: hex });
  });
}

function refreshStyleModal() {
  const app = findApp(styleTargetId);
  if (!app) return;
  const s = resolveTileStyle(app);

  const preview = document.getElementById('style-preview');
  if (preview) {
    preview.style.cssText = tileFaceStyle(app);
    preview.innerHTML = iconMarkup(app);
  }
  const nameEl = document.getElementById('style-app-name');
  if (nameEl) nameEl.textContent = app.name;

  document.querySelectorAll('#style-modal .swatch').forEach(sw => {
    const m = sw.dataset.mode;
    const v = sw.dataset.value;
    let selected = m === s.mode;
    if (selected && m === 'gradient') selected = v === s.gradient;
    if (selected && m === 'color') selected = v.toLowerCase() === s.color;
    sw.classList.toggle('selected', selected);
  });

  const colorInput = document.getElementById('style-custom-color');
  if (colorInput && colorInput.value !== s.color) colorInput.value = s.color;
  const hexInput = document.getElementById('style-custom-hex');
  if (hexInput && document.activeElement !== hexInput) hexInput.value = s.color.toUpperCase();

  const slider = document.getElementById('style-opacity');
  if (slider) {
    slider.value = String(s.opacity);
    slider.disabled = s.mode === 'transparent' || s.mode === 'glass';
  }
  const opacityLabel = document.getElementById('style-opacity-label');
  if (opacityLabel && slider) {
    opacityLabel.textContent = slider.disabled ? 'n/a' : `${s.opacity}%`;
  }
}

function updateTileStyle(patch) {
  const app = findApp(styleTargetId);
  if (!app) return;
  app.tileStyle = { ...resolveTileStyle(app), ...patch };
  styleDirty = true;
  refreshStyleModal();
  refreshTileFace(app);
  clearTimeout(styleSaveTimer);
  styleSaveTimer = setTimeout(flushStyleSave, 300);
}

async function flushStyleSave() {
  clearTimeout(styleSaveTimer);
  styleSaveTimer = null;
  if (!styleDirty) return;
  styleDirty = false;
  const app = findApp(styleTargetId);
  if (!app) return;
  try {
    await saveAppToDB(app);
  } catch (err) {
    recordLog('STYLE_ERR', `Could not save tile style: ${err}`);
    showToast('Could not save tile style');
  }
}

function onStyleModalClosed() {
  flushStyleSave();
}

function openStyleModal(appId) {
  const app = findApp(appId);
  if (!app) return;
  styleTargetId = app.id;
  styleDirty = false;
  buildStyleSwatches();
  refreshStyleModal();
  openModal('style-modal');
}

async function applyStyleToAll() {
  const app = findApp(styleTargetId);
  if (!app) return;
  if (!confirm(`Apply this tile style to all ${apps.length} apps?`)) return;
  const style = resolveTileStyle(app);
  apps.forEach(a => { a.tileStyle = { ...style }; });
  clearTimeout(styleSaveTimer);
  styleDirty = false;
  try {
    await saveAppsToDB(apps);
  } catch (err) {
    recordLog('STYLE_ERR', `Could not save styles: ${err}`);
    showToast('Could not save tile styles');
    return;
  }
  renderLauncher();
  showToast('Style applied to all apps');
}

// ---- Home-screen shortcuts ----
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch (e) {}
  const el = document.getElementById('shortcut-url');
  try { el.value = t; el.select(); return document.execCommand('copy'); } catch (e) { return false; }
}

function openShortcutModal(id) {
  const app = findApp(id);
  if (!app) return;
  const url = shortcutUrl(app.id);
  const urlEl = document.getElementById('shortcut-url');
  const lcEl = document.getElementById('shortcut-lc');
  document.getElementById('shortcut-title').textContent = 'Add ' + app.name + ' to Home Screen';
  urlEl.value = url;
  lcEl.value = getLcBundle();
  document.getElementById('btn-sc-copy').onclick = async () => showToast((await copyText(url)) ? 'Link copied' : 'Copy failed');
  document.getElementById('btn-sc-lc').onclick = async () => {
    const b = lcEl.value.trim();
    if (!b) return showToast('Enter the bundle name first');
    setLcBundle(b);
    const lc = liveContainerUrl(app.id, b);
    urlEl.value = lc;
    showToast((await copyText(lc)) ? 'LiveContainer link copied' : 'Copy failed');
  };
  document.getElementById('btn-sc-test').onclick = () => {
    const LL = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LaunchLink;
    if (LL) LL.openExternal({ url }).catch(e => showToast('Open failed'));
    else { closeModal('shortcut-modal'); launchApp(app, showToast, collapseFloatingMenu); }
  };
  document.getElementById('btn-sc-profile').onclick = async () => {
    try {
      const png = await renderIconPng(app);
      const xml = buildWebClip(app, url, png);
      const LS = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalServer;
      const LL = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LaunchLink;
      if (LS && LL) {
        const { port } = await LS.start();
        const bytes = new TextEncoder().encode(xml);
        let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        await LS.clearApp({ id: '__shortcuts__' });
        await LS.writeFile({ id: '__shortcuts__', path: 'shortcut.mobileconfig', data: btoa(bin), append: false });
        await LS.finish({ id: '__shortcuts__', version: String(Date.now()) });
        await LL.openExternal({ url: 'http://127.0.0.1:' + port + '/__shortcuts__/shortcut.mobileconfig' });
        showToast('Install in Settings > Profile Downloaded');
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([xml], { type: 'application/x-apple-aspen-config' }));
        a.download = app.name + '.mobileconfig'; a.click();
      }
    } catch (e) { recordLog('SHORTCUT_ERR', String(e)); showToast('Could not create profile'); }
  };
  openModal('shortcut-modal');
}

function initStyleModal() {
  const colorInput = document.getElementById('style-custom-color');
  const hexInput = document.getElementById('style-custom-hex');
  const slider = document.getElementById('style-opacity');

  if (colorInput) {
    colorInput.addEventListener('input', () => updateTileStyle({ mode: 'color', color: colorInput.value }));
  }

  if (hexInput) {
    hexInput.addEventListener('input', () => {
      const hex = normalizeHex(hexInput.value);
      if (hex) updateTileStyle({ mode: 'color', color: hex });
    });
    hexInput.addEventListener('blur', refreshStyleModal);
  }

  if (slider) {
    slider.addEventListener('input', () => updateTileStyle({ opacity: Number(slider.value) }));
  }

  const btnReset = document.getElementById('btn-style-reset');
  if (btnReset) {
    btnReset.onclick = () => {
      const app = findApp(styleTargetId);
      if (!app) return;
      delete app.tileStyle;
      styleDirty = true;
      refreshStyleModal();
      refreshTileFace(app);
      clearTimeout(styleSaveTimer);
      styleSaveTimer = setTimeout(flushStyleSave, 300);
    };
  }

  const btnAll = document.getElementById('btn-style-all');
  if (btnAll) btnAll.onclick = applyStyleToAll;

  const btnSc = document.getElementById('btn-style-shortcut');
  if (btnSc) btnSc.onclick = () => {
    const id = styleTargetId;
    closeModal('style-modal');
    if (id != null) openShortcutModal(id);
  };

  const btnIcon = document.getElementById('btn-style-icon');
  if (btnIcon) {
    btnIcon.onclick = () => {
      const id = styleTargetId;
      closeModal('style-modal');
      if (id != null) openIconPickerForApp(id);
    };
  }
}

// =========================================================================
// DRAG TO REARRANGE (edit mode: touch & hold a tile, or click-drag with a mouse)
// =========================================================================
const LONG_PRESS_MS = 260;
const SCROLL_CANCEL_PX = 8;
const MOUSE_DRAG_PX = 5;

let press = null;
let drag = null;

function layoutRect(el) {
  const main = getScrollerEl();
  const mr = main.getBoundingClientRect();
  const left = mr.left + el.offsetLeft - main.scrollLeft;
  const top = mr.top + el.offsetTop - main.scrollTop;
  return { left, top, right: left + el.offsetWidth, bottom: top + el.offsetHeight };
}

function gridTiles() {
  const grid = document.getElementById('app-grid');
  if (!grid) return [];
  return Array.from(grid.children).filter(el => el.classList.contains('app-tile'));
}

function attachDrag(tile) {
  tile.addEventListener('contextmenu', (e) => e.preventDefault());
  tile.addEventListener('pointerdown', (e) => {
    if (!isEditMode || drag || press) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('.edit-action-btn')) return;
    try {
      if (e.target.hasPointerCapture && e.target.hasPointerCapture(e.pointerId)) {
        e.target.releasePointerCapture(e.pointerId);
      }
    } catch (_) {}

    press = {
      tile, pointerId: e.pointerId, pointerType: e.pointerType,
      startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, timer: null
    };
    if (e.pointerType !== 'mouse') {
      press.timer = setTimeout(beginDrag, LONG_PRESS_MS);
    }
  });
}

function beginDrag() {
  if (!press || drag) return;
  if (press.timer) { clearTimeout(press.timer); press.timer = null; }

  if (searchQuery.trim()) {
    showToast('Clear the search to rearrange apps');
    press = null;
    return;
  }

  const tile = press.tile;
  const rect = tile.getBoundingClientRect();
  const ghost = tile.cloneNode(true);
  ghost.classList.add('drag-ghost');
  ghost.removeAttribute('data-app-id');
  ghost.style.position = 'fixed';
  ghost.style.margin = '0';
  ghost.style.width = rect.width + 'px';
  ghost.style.height = rect.height + 'px';
  ghost.style.left = rect.left + 'px';
  ghost.style.top = rect.top + 'px';
  document.body.appendChild(ghost);
  tile.classList.add('is-placeholder');

  drag = {
    tile, ghost,
    offX: press.x - rect.left,
    offY: press.y - rect.top,
    scrollTimer: setInterval(autoScrollTick, 16)
  };
  try { if (navigator.vibrate) navigator.vibrate(12); } catch (_) {}
  updateDrag();
}

function updateDrag() {
  if (!drag || !press) return;
  const { ghost, tile } = drag;
  ghost.style.left = (press.x - drag.offX) + 'px';
  ghost.style.top = (press.y - drag.offY) + 'px';

  const tiles = gridTiles();
  const target = tiles.find(t => {
    if (t === tile) return false;
    const r = layoutRect(t);
    return press.x >= r.left && press.x <= r.right && press.y >= r.top && press.y <= r.bottom;
  });
  if (!target) return;

  const first = new Map(tiles.map(t => [t, t.getBoundingClientRect()]));
  if (tiles.indexOf(tile) < tiles.indexOf(target)) target.after(tile);
  else target.before(tile);

  tiles.forEach(t => {
    if (t === tile || !t.animate) return;
    const f = first.get(t);
    const l = layoutRect(t);
    const dx = f.left - l.left;
    const dy = f.top - l.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    t.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
      { duration: 170, easing: 'ease-out' }
    );
  });
}

function autoScrollTick() {
  if (!drag || !press) return;
  const main = getScrollerEl();
  if (!main) return;
  const r = main.getBoundingClientRect();
  const zone = 56;
  let dy = 0;
  if (press.y < r.top + zone) dy = -Math.min(14, Math.ceil((r.top + zone - press.y) / 5));
  else if (press.y > r.bottom - zone) dy = Math.min(14, Math.ceil((press.y - (r.bottom - zone)) / 5));
  if (dy) {
    main.scrollTop += dy;
    updateDrag();
  }
}

function finishPress() {
  const p = press;
  press = null;
  if (p && p.timer) clearTimeout(p.timer);
  if (!drag) return;

  const { tile, ghost, scrollTimer } = drag;
  drag = null;
  clearInterval(scrollTimer);
  ghost.remove();
  tile.classList.remove('is-placeholder');
  suppressClickUntil = Date.now() + 350;
  commitOrderFromDOM();
}

async function commitOrderFromDOM() {
  const byId = new Map(apps.map(a => [String(a.id), a]));
  const reordered = gridTiles().map(t => byId.get(t.dataset.appId)).filter(Boolean);
  if (reordered.length !== apps.length) { renderLauncher(); return; }

  const changed = [];
  reordered.forEach((app, i) => {
    if (app.order !== i) {
      app.order = i;
      changed.push(app);
    }
  });
  apps = reordered;
  if (changed.length === 0) return;

  try {
    await saveAppsToDB(changed);
    recordLog('APP_REORDERED', `Home screen order saved (${changed.length} moved)`);
  } catch (err) {
    recordLog('ORDER_ERR', `Could not save app order: ${err}`);
    showToast('Could not save new order');
  }
}

function initDragListeners() {
  document.addEventListener('pointermove', (e) => {
    if (!press || e.pointerId !== press.pointerId) return;
    press.x = e.clientX;
    press.y = e.clientY;
    if (drag) { updateDrag(); return; }

    const moved = Math.hypot(press.x - press.startX, press.y - press.startY);
    if (press.pointerType === 'mouse') {
      if (moved > MOUSE_DRAG_PX) beginDrag();
    } else if (moved > SCROLL_CANCEL_PX) {
      clearTimeout(press.timer);
      press = null;
    }
  });

  document.addEventListener('pointerup', (e) => {
    if (press && e.pointerId === press.pointerId) finishPress();
  });
  document.addEventListener('pointercancel', (e) => {
    if (press && e.pointerId === press.pointerId) finishPress();
  });
  window.addEventListener('blur', finishPress);

  document.addEventListener('touchmove', (e) => {
    if (drag && e.cancelable) e.preventDefault();
  }, { passive: false });
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
    order: nextOrder(),
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
  if (input) {
    input.value = targetApp.name;
    openModal('rename-modal');
    setTimeout(() => input.focus(), 150);
  }
}

async function saveRename() {
  const input = document.getElementById('rename-input');
  if (!input) return;
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
            tileStyle: item.tileStyle || undefined,
            order: Number.isFinite(item.order) ? item.order : undefined,
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
  syncNativePlugins();
  setupFloatingMenu();
  initSearch();
  initStyleModal();
  initDragListeners();

  await initDatabase();
  await refreshApps();
  listenForShortcuts((id) => {
    const a = findApp(id);
    if (a) launchApp(a, showToast, collapseFloatingMenu);
    else showToast('Shortcut app not found');
  });

  recordLog('SMB_STATUS', window.Smb ? 'Native SMB plugin detected and ready.' : 'Native SMB plugin not available (in-browser or not compiled into host).');

  // Top Nav Buttons
  const btnDownloadLogs = document.getElementById('btn-download-logs');
  if (btnDownloadLogs) btnDownloadLogs.onclick = downloadAppLogs;

  const btnOpenBackup = document.getElementById('btn-open-backup');
  if (btnOpenBackup) btnOpenBackup.onclick = () => openModal('backup-modal');

  const btnOpenImport = document.getElementById('btn-open-import');
  if (btnOpenImport) btnOpenImport.onclick = () => openModal('import-modal');

  const emptyImportBtn = document.getElementById('empty-import-btn');
  if (emptyImportBtn) emptyImportBtn.onclick = () => openModal('import-modal');

  const emptyRestoreBtn = document.getElementById('empty-restore-btn');
  if (emptyRestoreBtn) emptyRestoreBtn.onclick = () => triggerPicker('backup-picker');

  // Edit Mode Toggle
  const editBtn = document.getElementById('edit-toggle-btn');
  if (editBtn) {
    editBtn.onclick = () => {
      isEditMode = !isEditMode;
      editBtn.innerText = isEditMode ? 'Done' : 'Edit';
      editBtn.style.background = isEditMode ? '#0A84FF' : 'rgba(255,255,255,0.1)';
      const hint = document.getElementById('footer-hint');
      if (hint) {
        hint.innerText = isEditMode
          ? 'Touch & hold a tile to move it · Tap a tile to change its color'
          : 'Tap an app to launch full-screen';
      }
      renderLauncher();
    };
  }

  // Modals Close Delegation
  document.querySelectorAll('.btn-close-modal').forEach(btn => {
    btn.onclick = () => closeModal(btn.getAttribute('data-target'));
  });

  // Modal Actions
  document.querySelectorAll('[data-picker]').forEach(btn => {
    btn.onclick = () => triggerPicker(btn.getAttribute('data-picker'));
  });

  const btnSaveRename = document.getElementById('btn-save-rename');
  if (btnSaveRename) btnSaveRename.onclick = saveRename;

  const btnSaveCrash = document.getElementById('btn-save-crash-log');
  if (btnSaveCrash) btnSaveCrash.onclick = downloadAppLogs;

  const btnExportAll = document.getElementById('btn-export-all');
  if (btnExportAll) btnExportAll.onclick = exportAllApps;

  const btnRestore = document.getElementById('btn-restore-backup');
  if (btnRestore) btnRestore.onclick = () => triggerPicker('backup-picker');

  const btnWipe = document.getElementById('btn-wipe-all');
  if (btnWipe) {
    btnWipe.onclick = async () => {
      if (confirm("Delete ALL apps? Make sure you exported a backup first.")) {
        await clearAllAppsFromDB();
        await refreshApps();
        closeModal('backup-modal');
        showToast("All apps deleted.");
      }
    };
  }

  // Floating Menu Actions
  const btnExit = document.getElementById('btn-runtime-exit');
  if (btnExit) {
    btnExit.onclick = () => {
      const nativeTTS = getNativeTTS();
      if (nativeTTS) nativeTTS.stop().catch(() => {});
      exitApp();
    };
  }

  const btnLogs = document.getElementById('btn-runtime-logs');
  if (btnLogs) btnLogs.onclick = downloadAppLogs;

  const btnReload = document.getElementById('btn-runtime-reload');
  if (btnReload) btnReload.onclick = () => reloadApp(showToast);

  const btnMode = document.getElementById('btn-runtime-mode');
  if (btnMode) btnMode.onclick = () => cycleLaunchMode(showToast);

  const btnCollapse = document.getElementById('btn-runtime-collapse');
  if (btnCollapse) btnCollapse.onclick = collapseFloatingMenu;

  // File Inputs
  const iconPicker = document.getElementById('icon-picker');
  if (iconPicker) iconPicker.onchange = handleIconPicked;

  const backupPicker = document.getElementById('backup-picker');
  if (backupPicker) backupPicker.onchange = handleBackupSelected;

  const folderPicker = document.getElementById('folder-picker');
  if (folderPicker) {
    folderPicker.onchange = async (e) => {
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
  }

  const multifilePicker = document.getElementById('multifile-picker');
  if (multifilePicker) {
    multifilePicker.onchange = async (e) => {
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
  }

  const zipPicker = document.getElementById('zip-picker');
  if (zipPicker) {
    zipPicker.onchange = async (e) => {
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
  }

  const singlePicker = document.getElementById('single-picker');
  if (singlePicker) {
    singlePicker.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const content = await readFileContent(file);
      let appName = file.name.replace(/\.[^/.]+$/, "");
      const titleMatch = content.content.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (titleMatch && titleMatch[1].trim()) appName = titleMatch[1].trim();
      await finalizeMultiFileApp({ 'index.html': content }, appName);
    };
  }
});
