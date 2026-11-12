// =========================================================================
// PERSISTENT CRASH & DIAGNOSTIC LOGGER MODULE
// =========================================================================
const LOG_KEY = 'weblauncher_debug_log_v2';
export let systemLogs = [];

export function recordLog(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  systemLogs.push(line);
  if (systemLogs.length > 500) systemLogs.shift();
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(systemLogs));
  } catch (e) {}
}

export function initLogger() {
  try {
    const prev = localStorage.getItem(LOG_KEY);
    if (prev) systemLogs = JSON.parse(prev);
  } catch (e) {}

  window.recordChildLog = function(level, msg) {
    recordLog(level, msg);
  };

  const _cLog = console.log, _cWarn = console.warn, _cErr = console.error;
  console.log = function(...a) { recordLog('INFO', a.join(' ')); _cLog.apply(console, a); };
  console.warn = function(...a) { recordLog('WARN', a.join(' ')); _cWarn.apply(console, a); };
  console.error = function(...a) { recordLog('ERROR', a.join(' ')); _cErr.apply(console, a); };

  window.onerror = function(m, u, l, c, e) {
    recordLog('FATAL_JS_ERR', `${m} at ${u}:${l}:${c} Stack: ${e?.stack || 'none'}`);
    return false;
  };

  window.onunhandledrejection = function(e) {
    recordLog('UNHANDLED_REJECTION', `Reason: ${e.reason?.message || e.reason}`);
  };

  recordLog('BOOT', `Launcher booted. Viewport: ${window.innerWidth}x${window.innerHeight}`);
}

export function downloadAppLogs() {
  const header = `====================================================\nWEBLAUNCHER DIAGNOSTIC & CRASH LOG\nExported: ${new Date().toISOString()}\nUser-Agent: ${navigator.userAgent}\nTotal Entries: ${systemLogs.length}\n====================================================\n\n`;
  const content = header + systemLogs.join('\n');
  const filename = `weblauncher-crash-log-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;

  if (navigator.share && navigator.canShare) {
    try {
      const file = new File([content], filename, { type: 'text/plain' });
      if (navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: "WebLauncher Crash Log" }).catch(() => {});
        return;
      }
    } catch (e) {}
  }

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}