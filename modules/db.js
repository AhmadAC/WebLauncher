// =========================================================================
// INDEXEDDB DATA ACCESS LAYER MODULE
// =========================================================================
let db = null;

// Deleted apps stay in the 'trash' store for this long, then are purged automatically.
export const TRASH_RETENTION_MS = 10 * 24 * 60 * 60 * 1000; // 10 days

export function initDatabase() {
  return new Promise((resolve, reject) => {
    // v2 adds the 'trash' store. Existing 'apps' data is untouched by the upgrade.
    const req = indexedDB.open('LauncherDB', 2);
    req.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains('apps')) {
        database.createObjectStore('apps', { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains('trash')) {
        // Each entry: { trashId, trashedAt, app } - `app` is the complete original record.
        const trash = database.createObjectStore('trash', { keyPath: 'trashId' });
        trash.createIndex('trashedAt', 'trashedAt', { unique: false });
      }
    };
    req.onsuccess = (e) => {
      db = e.target.result;
      // Let a newer version of the page upgrade the DB instead of being blocked by this one.
      db.onversionchange = () => { try { db.close(); } catch (err) {} };
      resolve(db);
    };
    req.onerror = () => reject("IndexedDB failed to load");
  });
}

export function loadAppsFromDB() {
  return new Promise((resolve) => {
    if (!db) return resolve([]);
    const tx = db.transaction('apps', 'readonly');
    const store = tx.objectStore('apps');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}

export function saveAppToDB(app) {
  return new Promise((resolve, reject) => {
    if (!db) return reject("DB not initialized");
    const tx = db.transaction('apps', 'readwrite');
    const store = tx.objectStore('apps');
    store.put(app);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e);
  });
}

// Saves several apps in ONE transaction (used for reordering / "apply style to all").
export function saveAppsToDB(list) {
  return new Promise((resolve, reject) => {
    if (!db) return reject("DB not initialized");
    if (!list || list.length === 0) return resolve();
    const tx = db.transaction('apps', 'readwrite');
    const store = tx.objectStore('apps');
    list.forEach(app => store.put(app));
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e);
    tx.onabort = (e) => reject(e);
  });
}

export function deleteAppFromDB(id) {
  return new Promise((resolve) => {
    if (!db) return resolve();
    const tx = db.transaction('apps', 'readwrite');
    const store = tx.objectStore('apps');
    store.delete(id);
    if (!isNaN(Number(id))) {
      store.delete(Number(id));
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export function clearAllAppsFromDB() {
  return new Promise((resolve) => {
    if (!db) return resolve();
    const tx = db.transaction('apps', 'readwrite');
    const store = tx.objectStore('apps');
    store.clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

// =========================================================================
// TRASH (soft delete with undo + automatic purge)
// Deleting an app MOVES it into the 'trash' store inside a single
// transaction, so an app can never be lost halfway (removed from 'apps'
// but not saved to 'trash').
// =========================================================================
function makeTrashId(app) {
  return `${Date.now()}-${String(app.id)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Reads an app by id, also trying the numeric form (ids are Date.now() numbers,
// but the UI sometimes passes them around as strings).
function getAppById(store, id, cb) {
  const r = store.get(id);
  r.onsuccess = () => {
    if (r.result || isNaN(Number(id)) || typeof id === 'number') return cb(r.result);
    const r2 = store.get(Number(id));
    r2.onsuccess = () => cb(r2.result);
  };
}

// Moves one app into the trash. Resolves with its trashId (or null if not found).
export function moveAppToTrash(id) {
  return new Promise((resolve, reject) => {
    if (!db) return reject("DB not initialized");
    const tx = db.transaction(['apps', 'trash'], 'readwrite');
    const appsStore = tx.objectStore('apps');
    const trashStore = tx.objectStore('trash');
    let trashId = null;
    getAppById(appsStore, id, (app) => {
      if (!app) return;
      trashId = makeTrashId(app);
      trashStore.put({ trashId, trashedAt: Date.now(), app });
      appsStore.delete(app.id);
    });
    tx.oncomplete = () => resolve(trashId);
    tx.onerror = (e) => reject(e);
    tx.onabort = (e) => reject(e);
  });
}

// Moves every app into the trash ("Delete All Apps"). Resolves with the list of trashIds.
export function moveAllAppsToTrash() {
  return new Promise((resolve, reject) => {
    if (!db) return reject("DB not initialized");
    const tx = db.transaction(['apps', 'trash'], 'readwrite');
    const appsStore = tx.objectStore('apps');
    const trashStore = tx.objectStore('trash');
    const trashIds = [];
    const req = appsStore.getAll();
    req.onsuccess = () => {
      const now = Date.now();
      (req.result || []).forEach(app => {
        const trashId = makeTrashId(app);
        trashIds.push(trashId);
        trashStore.put({ trashId, trashedAt: now, app });
      });
      appsStore.clear();
    };
    tx.oncomplete = () => resolve(trashIds);
    tx.onerror = (e) => reject(e);
    tx.onabort = (e) => reject(e);
  });
}

// Lightweight list for the Trash screen, newest deletion first.
export function loadTrashFromDB() {
  return new Promise((resolve) => {
    if (!db) return resolve([]);
    const tx = db.transaction('trash', 'readonly');
    const req = tx.objectStore('trash').getAll();
    req.onsuccess = () => {
      const list = (req.result || []).map(t => ({
        trashId: t.trashId,
        trashedAt: t.trashedAt,
        id: t.app && t.app.id,
        name: (t.app && t.app.name) || 'Untitled',
        icon: (t.app && t.app.icon) || null,
        gradient: t.app && t.app.gradient,
        tileStyle: t.app && t.app.tileStyle
      }));
      list.sort((a, b) => b.trashedAt - a.trashedAt);
      resolve(list);
    };
    req.onerror = () => resolve([]);
  });
}

// Puts one or more trashed apps back on the home screen. Accepts a trashId or an array.
// Resolves with the number of apps restored.
export function restoreFromTrash(trashIds) {
  const ids = Array.isArray(trashIds) ? trashIds : [trashIds];
  return new Promise((resolve, reject) => {
    if (!db) return reject("DB not initialized");
    const tx = db.transaction(['apps', 'trash'], 'readwrite');
    const appsStore = tx.objectStore('apps');
    const trashStore = tx.objectStore('trash');
    let restored = 0;
    ids.forEach((trashId, n) => {
      const getReq = trashStore.get(trashId);
      getReq.onsuccess = () => {
        const entry = getReq.result;
        if (!entry || !entry.app) return;
        const app = entry.app;
        const existing = appsStore.get(app.id);
        existing.onsuccess = () => {
          // Extremely unlikely, but never overwrite a live app with the same id.
          if (existing.result) app.id = Date.now() + n + Math.floor(Math.random() * 1000);
          appsStore.put(app);
          trashStore.delete(trashId);
          restored++;
        };
      };
    });
    tx.oncomplete = () => resolve(restored);
    tx.onerror = (e) => reject(e);
    tx.onabort = (e) => reject(e);
  });
}

// Permanently deletes specific trashed apps. Accepts a trashId or an array.
export function deleteFromTrash(trashIds) {
  const ids = Array.isArray(trashIds) ? trashIds : [trashIds];
  return new Promise((resolve, reject) => {
    if (!db) return reject("DB not initialized");
    const tx = db.transaction('trash', 'readwrite');
    const store = tx.objectStore('trash');
    ids.forEach(id => store.delete(id));
    tx.oncomplete = () => resolve(ids.length);
    tx.onerror = (e) => reject(e);
    tx.onabort = (e) => reject(e);
  });
}

// Permanently deletes everything in the trash. Resolves with how many apps were removed.
export function emptyTrash() {
  return new Promise((resolve, reject) => {
    if (!db) return reject("DB not initialized");
    const tx = db.transaction('trash', 'readwrite');
    const store = tx.objectStore('trash');
    let count = 0;
    const c = store.count();
    c.onsuccess = () => { count = c.result; };
    store.clear();
    tx.oncomplete = () => resolve(count);
    tx.onerror = (e) => reject(e);
    tx.onabort = (e) => reject(e);
  });
}

// Permanently deletes trashed apps older than maxAgeMs (default 10 days).
// Uses the trashedAt index with a key cursor so app contents are never loaded.
export function purgeExpiredTrash(maxAgeMs = TRASH_RETENTION_MS) {
  return new Promise((resolve) => {
    if (!db) return resolve(0);
    let purged = 0;
    try {
      const tx = db.transaction('trash', 'readwrite');
      const store = tx.objectStore('trash');
      const range = IDBKeyRange.upperBound(Date.now() - maxAgeMs);
      const cur = store.index('trashedAt').openKeyCursor(range);
      cur.onsuccess = () => {
        const cursor = cur.result;
        if (!cursor) return;
        store.delete(cursor.primaryKey);
        purged++;
        cursor.continue();
      };
      tx.oncomplete = () => resolve(purged);
      tx.onerror = () => resolve(0);
      tx.onabort = () => resolve(0);
    } catch (err) {
      resolve(0);
    }
  });
}
