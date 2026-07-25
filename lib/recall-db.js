/* Shared read access to the Total Recall IndexedDB archive.
 * Extension pages use this for portable backup creation; writes remain owned
 * by bg.js so archive validation and merge rules stay in one place. */
(() => {
  "use strict";

  const DB_NAME = "lct-recall";
  const DB_VERSION = 1;
  let openPromise = null;

  function open() {
    if (openPromise) return openPromise;
    openPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("chats")) {
          const store = db.createObjectStore("chats", { keyPath: "id" });
          store.createIndex("updatedAt", "updatedAt");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { openPromise = null; reject(req.error); };
    });
    return openPromise;
  }

  async function getAll() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const out = [];
      const req = db.transaction("chats", "readonly").objectStore("chats").openCursor();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve(out);
        out.push(cursor.value);
        cursor.continue();
      };
    });
  }

  self.LCTRecallDB = { getAll };
})();
