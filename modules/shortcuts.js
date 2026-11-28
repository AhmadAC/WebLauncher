// =========================================================================
// HOME-SCREEN SHORTCUTS: weblauncher://launch?app=<id> deep links
// =========================================================================
import { recordLog } from './logger.js';

const LC_KEY = 'wl_lc_bundle';

export function shortcutUrl(id) {
  return 'weblauncher://launch?app=' + encodeURIComponent(String(id));
}

export function parseLaunchUrl(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'weblauncher:') return null;
    const id = u.searchParams.get('app');
    return id ? id : null;
  } catch (e) { return null; }
}

export function getLcBundle() {
  try { return localStorage.getItem(LC_KEY) || ''; } catch (e) { return ''; }
}
export function setLcBundle(v) {
  try { localStorage.setItem(LC_KEY, v); } catch (e) {}
}

// LiveContainer link that launches this launcher (by bundle id / name) and hands it the shortcut URL.
// The exact LiveContainer parameters are unverified; the launcher also accepts the plain scheme.
export function liveContainerUrl(id, bundle) {
  const b64 = btoa(shortcutUrl(id));
  const base = String(bundle).trim();
  // Preferred: the user pastes LiveContainer's own "Copy Launch URL"; we append the shortcut link to it.
  if (/^livecontainer:\/\//i.test(base)) {
    return base + (base.includes('?') ? '&' : '?') + 'open-url=' + encodeURIComponent(b64);
  }
  return 'livecontainer://livecontainer-launch?bundle-name=' + encodeURIComponent(base) + '&open-url=' + encodeURIComponent(b64);
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// WebClip profile: installing it (Settings > Profile Downloaded) puts an icon on the home screen.
export function buildWebClip(app, url, iconPng) {
  const uid = (self.crypto && crypto.randomUUID) ? crypto.randomUUID().toUpperCase() : 'A0000000-0000-4000-8000-' + String(Date.now()).padStart(12, '0');
  const uid2 = (self.crypto && crypto.randomUUID) ? crypto.randomUUID().toUpperCase() : 'B0000000-0000-4000-8000-' + String(Date.now()).padStart(12, '0');
  const icon = iconPng ? `<key>Icon</key><data>${iconPng}</data>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadContent</key><array><dict>
<key>PayloadType</key><string>com.apple.webClip.managed</string>
<key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>com.weblauncher.clip.${uid}</string>
<key>PayloadUUID</key><string>${uid}</string>
<key>PayloadDisplayName</key><string>${esc(app.name)}</string>
<key>Label</key><string>${esc(app.name)}</string>
<key>URL</key><string>${esc(url)}</string>
<key>IsRemovable</key><true/>
<key>FullScreen</key><true/>
${icon}
</dict></array>
<key>PayloadDisplayName</key><string>${esc(app.name)} shortcut</string>
<key>PayloadIdentifier</key><string>com.weblauncher.profile.${uid2}</string>
<key>PayloadType</key><string>Configuration</string>
<key>PayloadUUID</key><string>${uid2}</string>
<key>PayloadVersion</key><integer>1</integer>
</dict></plist>`;
}

// Renders the app's SVG icon (or first letter) to a 180px PNG, returns base64 or ''.
export async function renderIconPng(app) {
  try {
    const c = document.createElement('canvas'); c.width = c.height = 180;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#2563eb'; ctx.fillRect(0, 0, 180, 180);
    let drawn = false;
    if (app.icon) {
      const src = String(app.icon).startsWith('data:') ? app.icon : 'data:image/svg+xml;base64,' + app.icon;
      await new Promise(res => { const im = new Image(); im.onload = () => { ctx.drawImage(im, 20, 20, 140, 140); drawn = true; res(); }; im.onerror = res; im.src = src; });
    }
    if (!drawn) { ctx.fillStyle = '#fff'; ctx.font = 'bold 96px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText((app.name || '?')[0].toUpperCase(), 90, 94); }
    return c.toDataURL('image/png').split(',')[1];
  } catch (e) { return ''; }
}

// Hooks native URL events; onLaunch(id) is called once for every shortcut open.
//
// BUG FIX (black screen after shortcut launch): on a cold start iOS delivers the
// same link TWICE — once through the `urlOpen` event and once through the
// `getLaunchUrl()` snapshot. Each delivery used to start a second launch, which
// restarted the loopback server on a new port and wiped the files the first
// launch was still serving, leaving a blank iframe until a manual reload.
// Identical links inside a short window are now collapsed into one launch.
export function listenForShortcuts(onLaunch) {
  let lastUrl = '';
  let lastTime = 0;
  const DEDUPE_MS = 3000;

  const handle = (u) => {
    const raw = String(u || '');
    const now = Date.now();
    if (raw && raw === lastUrl && (now - lastTime) < DEDUPE_MS) {
      recordLog('SHORTCUT_DEDUPE', `Ignored duplicate delivery of ${raw.slice(0, 120)}`);
      return;
    }
    lastUrl = raw;
    lastTime = now;
    const id = parseLaunchUrl(raw);
    if (id) onLaunch(id);
  };

  const LL = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LaunchLink;
  if (LL) {
    try { LL.addListener('urlOpen', (e) => handle(e && e.url)); } catch (e) {}
    try { LL.getLaunchUrl().then(r => handle(r && r.url)).catch(() => {}); } catch (e) {}
  }
  // Web / fallback: Index.html#launch=<id> or ?launch=<id>
  const m = /[#?&]launch=([^&]+)/.exec(location.hash + location.search);
  if (m) handle('weblauncher://launch?app=' + m[1]);
}
