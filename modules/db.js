// =========================================================================
// INDEXEDDB DATA ACCESS LAYER MODULE
// =========================================================================
let db = null;

export function initDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('LauncherDB', 1);
    req.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains('apps')) {
        database.createObjectStore('apps', { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => {
      db = e.target.result;
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