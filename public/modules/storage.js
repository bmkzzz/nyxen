/**
 * Nyxen EPUB Reader - Modular Storage Layer (IndexedDB v11 + Fail-Safe RAM)
 * Preserves full schema compatibility with LuminaAppDB v11 and exposes
 * clean, UI-decoupled adapters for raw stores, books, assets, and settings.
 */
(function (globalScope) {
  "use strict";

  const DB_NAME = "LuminaAppDB";
  const DB_VERSION = 11;
  const CHAPTER_CHUNK_SIZE = 15;

  const STORE_KEY_PATHS = {
    books: "id",
    bookContents: "bookId",
    bookAssets: "assetKey",
    customFonts: "name",
    settings: "key",
    themes: "id",
    swatches: "color",
    dictPacks: "lang"
  };

  const inMemoryDb = {
    books: [],
    bookContents: [],
    bookAssets: [],
    customFonts: [],
    settings: [],
    themes: [],
    swatches: [],
    dictPacks: []
  };

  let db = null;
  let dbOpeningPromise = null;
  let pendingOpenState = null;
  let dbInitBlocked = false;
  let dbPermanentUnavailable = false;
  let dbRetryNotBefore = 0;
  let lastHydratedBookId = null;
  let lastIssuedProgressTs = 0;
  let recoveryDrainScheduled = false;

  const DB_OPEN_TIMEOUT_MS = 4500;
  const DB_RETRY_COOLDOWN_MS = 8000;
  const STORAGE_SESSION_ID = (
    globalScope.crypto && typeof globalScope.crypto.randomUUID === "function"
      ? globalScope.crypto.randomUUID()
      : ("sess_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10))
  );

  const activeObjectUrls = new Map();
  const bookWriteQueues = new Map();
  const knownDiskRevisionByBook = new Map();
  const bookSeqCounters = new Map();
  const pendingRecoveryProgressPatches = new Map();
  const deletedBookIdsInSession = new Set();

  // UI & state integration hooks configured by the host application
  const hooks = {
    onQuotaExceeded: null,
    onStatusChange: null,
    getBooksList: () => [],
    setBooksList: () => {},
    getCurrentBook: () => null,
    onBeforeDeleteBook: null,
    onRevokeCover: null,
    onExternalProgressConflict: null,
    onRecoverySync: null
  };

  function configure(options = {}) {
    if (!options || typeof options !== "object") return;
    if (typeof options.onQuotaExceeded === "function") hooks.onQuotaExceeded = options.onQuotaExceeded;
    if (typeof options.onStatusChange === "function") hooks.onStatusChange = options.onStatusChange;
    if (typeof options.getBooksList === "function") hooks.getBooksList = options.getBooksList;
    if (typeof options.setBooksList === "function") hooks.setBooksList = options.setBooksList;
    if (typeof options.getCurrentBook === "function") hooks.getCurrentBook = options.getCurrentBook;
    if (typeof options.onBeforeDeleteBook === "function") hooks.onBeforeDeleteBook = options.onBeforeDeleteBook;
    if (typeof options.onRevokeCover === "function") hooks.onRevokeCover = options.onRevokeCover;
    if (typeof options.onExternalProgressConflict === "function") hooks.onExternalProgressConflict = options.onExternalProgressConflict;
    if (typeof options.onRecoverySync === "function") hooks.onRecoverySync = options.onRecoverySync;
  }

  function notifyStatusChange() {
    if (typeof hooks.onStatusChange === "function") {
      try {
        hooks.onStatusChange({ blocked: dbInitBlocked, hasDb: Boolean(db), permanent: dbPermanentUnavailable });
      } catch (e) {}
    }
  }

  function notifyQuotaExceeded() {
    if (typeof hooks.onQuotaExceeded === "function") {
      try {
        hooks.onQuotaExceeded();
      } catch (e) {}
    }
  }

  function isQuotaError(err) {
    return Boolean(err && (err.name === "QuotaExceededError" || err.code === 22));
  }

  function isInvalidStateError(err) {
    return Boolean(err && (err.name === "InvalidStateError" || String(err.message || "").toLowerCase().includes("closing")));
  }

  function isUsingTempMemoryStorage() {
    return Boolean(dbInitBlocked || !db);
  }

  function isBlocked() {
    return Boolean(dbInitBlocked);
  }

  function hasDatabase() {
    return Boolean(db);
  }

  function getSessionId() {
    return STORAGE_SESSION_ID;
  }

  /**
   * progressUpdatedAt es exclusivamente una referencia temporal auxiliar del reloj local.
   * No debe usarse como verdad absoluta entre sesiones distintas.
   */
  function nextMonotonicProgressTimestamp() {
    lastIssuedProgressTs = Math.max(Date.now(), lastIssuedProgressTs + 1);
    return lastIssuedProgressTs;
  }

  function registerBookDiskRevision(record) {
    if (!record || !record.id) return;
    const rev = typeof record.progressRevision === "number" && Number.isFinite(record.progressRevision)
      ? record.progressRevision
      : 0;
    const prevKnown = knownDiskRevisionByBook.get(record.id);
    if (prevKnown === undefined || rev > prevKnown) {
      knownDiskRevisionByBook.set(record.id, rev);
    }
    const diskSeq = typeof record.progressSeq === "number" && Number.isFinite(record.progressSeq)
      ? record.progressSeq
      : 0;
    const curSeq = bookSeqCounters.get(record.id) || 0;
    if (diskSeq > curSeq) {
      bookSeqCounters.set(record.id, diskSeq);
    }
  }

  function registerLoadedBooksRevisions(records) {
    if (!Array.isArray(records)) return;
    for (let i = 0; i < records.length; i++) {
      if (records[i] && records[i].id) {
        registerBookDiskRevision(records[i]);
      }
    }
  }

  function resetRetryCooldown() {
    if (!dbPermanentUnavailable) {
      dbRetryNotBefore = 0;
    }
  }

  function scheduleDrainRecoveryPatches() {
    if (recoveryDrainScheduled || pendingRecoveryProgressPatches.size === 0 || !db) return;
    recoveryDrainScheduled = true;
    setTimeout(() => {
      recoveryDrainScheduled = false;
      drainPendingRecoveryProgressPatches().catch(() => {});
    }, 0);
  }

  async function requestPersistentStorage() {
    try {
      if (navigator.storage && typeof navigator.storage.persist === "function") {
        const isPersisted = await navigator.storage.persisted();
        if (!isPersisted) await navigator.storage.persist();
      }
    } catch (e) {}
  }

  function waitWithTimeout(promise, ms) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve({ timedOut: true, db: null });
      }, ms);
      promise.then((resDb) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ timedOut: false, db: resDb || null });
      }).catch(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ timedOut: false, db: null });
      });
    });
  }

  function openDatabase() {
    if (db) return Promise.resolve(db);
    if (dbPermanentUnavailable) return Promise.resolve(null);

    // Si hay una petición indexedDB.open() todavía pendiente en el navegador (p. ej. tras onblocked o timeout),
    // nunca lanzamos una segunda apertura paralela.
    if (pendingOpenState && !pendingOpenState.finished) {
      if (Date.now() < dbRetryNotBefore) {
        return Promise.resolve(null);
      }
      return waitWithTimeout(pendingOpenState.lifecyclePromise, DB_OPEN_TIMEOUT_MS).then(({ timedOut, db: resDb }) => {
        if (timedOut) {
          dbInitBlocked = true;
          dbRetryNotBefore = Date.now() + DB_RETRY_COOLDOWN_MS;
          notifyStatusChange();
          return null;
        }
        return resDb;
      });
    }

    if (Date.now() < dbRetryNotBefore) {
      return Promise.resolve(null);
    }
    if (dbOpeningPromise) return dbOpeningPromise;

    if (!globalScope.indexedDB) {
      console.warn("IndexedDB no disponible, usando almacenamiento en memoria.");
      dbPermanentUnavailable = true;
      dbInitBlocked = true;
      notifyStatusChange();
      return Promise.resolve(null);
    }

    const state = {
      req: null,
      finished: false,
      lifecyclePromise: null
    };
    pendingOpenState = state;

    let resolveLifecycle;
    state.lifecyclePromise = new Promise((res) => {
      resolveLifecycle = res;
    });

    dbOpeningPromise = new Promise((resolveCaller) => {
      let callerSettled = false;
      const settleCaller = (val) => {
        if (callerSettled) return;
        callerSettled = true;
        clearTimeout(guardTimer);
        notifyStatusChange();
        resolveCaller(val);
      };

      const finishLifecycle = (resolvedDb) => {
        if (state.finished) return;
        state.finished = true;
        if (pendingOpenState === state) {
          pendingOpenState = null;
        }
        resolveLifecycle(resolvedDb || null);
      };

      const guardTimer = setTimeout(() => {
        console.warn("IndexedDB tardó demasiado en abrir, usando fallback temporal sin duplicar petición.");
        dbInitBlocked = true;
        dbRetryNotBefore = Date.now() + DB_RETRY_COOLDOWN_MS;
        // IMPORTANTE: NO limpiamos pendingOpenState aquí porque state.req sigue pendiente.
        settleCaller(null);
      }, DB_OPEN_TIMEOUT_MS);

      try {
        const req = globalScope.indexedDB.open(DB_NAME, DB_VERSION);
        state.req = req;
        req.onupgradeneeded = (e) => {
          const d = e.target.result;
          Object.entries(STORE_KEY_PATHS).forEach(([store, keyPath]) => {
            if (!d.objectStoreNames.contains(store)) {
              d.createObjectStore(store, { keyPath });
            }
          });
        };
        req.onsuccess = () => {
          const openedDb = req.result;
          db = openedDb;
          dbInitBlocked = false;
          dbRetryNotBefore = 0;
          openedDb.onversionchange = () => {
            try { openedDb.close(); } catch (e) {}
            if (db === openedDb) {
              db = null;
              notifyStatusChange();
            }
          };
          openedDb.onclose = () => {
            if (db === openedDb) {
              db = null;
              notifyStatusChange();
            }
          };
          finishLifecycle(openedDb);
          settleCaller(openedDb);
          scheduleDrainRecoveryPatches();
        };
        req.onerror = () => {
          const err = req.error;
          console.warn("Error abriendo IndexedDB, usando fallback temporal:", err && err.name);
          if (err && err.name === "SecurityError") {
            dbPermanentUnavailable = true;
          } else {
            dbRetryNotBefore = Date.now() + DB_RETRY_COOLDOWN_MS;
          }
          dbInitBlocked = true;
          finishLifecycle(null);
          settleCaller(null);
        };
        req.onblocked = () => {
          console.warn("IndexedDB bloqueado por otra pestaña.");
          dbInitBlocked = true;
          dbRetryNotBefore = Date.now() + DB_RETRY_COOLDOWN_MS;
          // IMPORTANTE: NO limpiamos pendingOpenState ni emitimos otro indexedDB.open() mientras req siga bloqueado.
          settleCaller(null);
        };
      } catch (err) {
        console.warn("Excepción abriendo IndexedDB:", err);
        if (err && err.name === "SecurityError") {
          dbPermanentUnavailable = true;
        } else {
          dbRetryNotBefore = Date.now() + DB_RETRY_COOLDOWN_MS;
        }
        dbInitBlocked = true;
        finishLifecycle(null);
        settleCaller(null);
      }
    }).finally(() => {
      dbOpeningPromise = null;
    });

    return dbOpeningPromise;
  }

  async function ensureDb() {
    if (db) return db;
    if (dbPermanentUnavailable) return null;
    return await openDatabase();
  }

  function putInMemoryStore(storeName, item) {
    if (db && (storeName === "bookAssets" || storeName === "bookContents")) return;
    const keyProp = STORE_KEY_PATHS[storeName] || "key";
    if (!inMemoryDb[storeName]) inMemoryDb[storeName] = [];
    const idx = inMemoryDb[storeName].findIndex(x => x && x[keyProp] === item[keyProp]);
    if (idx !== -1) inMemoryDb[storeName][idx] = item;
    else inMemoryDb[storeName].push(item);
  }

  function handleTransactionFailureAndMaybeReset(conn, err) {
    if (isInvalidStateError(err) && db === conn) {
      db = null;
      notifyStatusChange();
      return true;
    }
    return false;
  }

  async function dbSave(storeName, item) {
    let conn = await ensureDb();
    if (!conn) {
      putInMemoryStore(storeName, item);
      return true;
    }

    const attempt = (targetConn) => new Promise((resolve) => {
      let settled = false;
      const finish = (res) => {
        if (settled) return;
        settled = true;
        resolve(res);
      };
      try {
        const tx = targetConn.transaction(storeName, "readwrite");
        tx.objectStore(storeName).put(item);
        tx.oncomplete = () => finish({ ok: true, retryableInvalidState: false });
        tx.onerror = (ev) => {
          const err = tx.error || ev?.target?.error;
          if (isQuotaError(err)) notifyQuotaExceeded();
          const retryable = handleTransactionFailureAndMaybeReset(targetConn, err);
          finish({ ok: false, retryableInvalidState: retryable });
        };
        tx.onabort = () => {
          const err = tx.error;
          if (isQuotaError(err)) notifyQuotaExceeded();
          const retryable = handleTransactionFailureAndMaybeReset(targetConn, err);
          finish({ ok: false, retryableInvalidState: retryable });
        };
      } catch (e) {
        const retryable = handleTransactionFailureAndMaybeReset(targetConn, e);
        finish({ ok: false, retryableInvalidState: retryable });
      }
    });

    let res = await attempt(conn);
    if (!res.ok && res.retryableInvalidState) {
      resetRetryCooldown();
      conn = await ensureDb();
      if (conn) {
        res = await attempt(conn);
      }
    }
    return Boolean(res.ok);
  }

  async function dbGet(storeName, key) {
    let conn = await ensureDb();
    const keyProp = STORE_KEY_PATHS[storeName] || "key";
    if (!conn) {
      const list = inMemoryDb[storeName] || [];
      return list.find(x => x && x[keyProp] === key) || null;
    }

    const attempt = (targetConn) => new Promise((resolve) => {
      try {
        const tx = targetConn.transaction(storeName, "readonly");
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve({ ok: true, value: req.result || null, retryableInvalidState: false });
        req.onerror = () => resolve({ ok: false, value: null, retryableInvalidState: false });
      } catch (e) {
        const retryable = handleTransactionFailureAndMaybeReset(targetConn, e);
        resolve({ ok: false, value: null, retryableInvalidState: retryable });
      }
    });

    let res = await attempt(conn);
    if (!res.ok && res.retryableInvalidState) {
      resetRetryCooldown();
      conn = await ensureDb();
      if (conn) res = await attempt(conn);
    }
    if (res.ok && storeName === "books" && res.value) {
      registerBookDiskRevision(res.value);
    }
    return res.value;
  }

  async function dbGetAll(storeName) {
    let conn = await ensureDb();
    if (!conn) {
      return inMemoryDb[storeName] || [];
    }

    const attempt = (targetConn) => new Promise((resolve) => {
      try {
        const tx = targetConn.transaction(storeName, "readonly");
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve({ ok: true, value: req.result || [], retryableInvalidState: false });
        req.onerror = () => resolve({ ok: false, value: inMemoryDb[storeName] || [], retryableInvalidState: false });
      } catch (e) {
        const retryable = handleTransactionFailureAndMaybeReset(targetConn, e);
        resolve({ ok: false, value: inMemoryDb[storeName] || [], retryableInvalidState: retryable });
      }
    });

    let res = await attempt(conn);
    if (!res.ok && res.retryableInvalidState) {
      resetRetryCooldown();
      conn = await ensureDb();
      if (conn) res = await attempt(conn);
    }
    if (res.ok && storeName === "books") {
      registerLoadedBooksRevisions(res.value);
    }
    return res.value;
  }

  async function dbGetAllKeys(storeName) {
    const conn = await ensureDb();
    return new Promise((resolve) => {
      if (!conn) {
        const keyProp = STORE_KEY_PATHS[storeName] || "key";
        const list = inMemoryDb[storeName] || [];
        resolve(list.map(x => x && x[keyProp]).filter(Boolean));
        return;
      }
      try {
        const tx = conn.transaction(storeName, "readonly");
        const store = tx.objectStore(storeName);
        if (typeof store.getAllKeys === "function") {
          const req = store.getAllKeys();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve([]);
        } else {
          resolve([]);
        }
      } catch (e) {
        resolve([]);
      }
    });
  }

  async function dbClear(storeName) {
    if (storeName === "books") {
      knownDiskRevisionByBook.clear();
      bookSeqCounters.clear();
      pendingRecoveryProgressPatches.clear();
      deletedBookIdsInSession.clear();
    }
    const conn = await ensureDb();
    return new Promise((resolve) => {
      inMemoryDb[storeName] = [];
      if (!conn) {
        resolve();
        return;
      }

      try {
        const tx = conn.transaction(storeName, "readwrite");
        tx.objectStore(storeName).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (e) {
        resolve();
      }
    });
  }

  async function dbDelete(storeName, key) {
    const conn = await ensureDb();
    return new Promise((resolve) => {
      const keyProp = STORE_KEY_PATHS[storeName] || "key";
      if (inMemoryDb[storeName]) {
        inMemoryDb[storeName] = inMemoryDb[storeName].filter(x => x && x[keyProp] !== key);
      }
      if (!conn) {
        resolve();
        return;
      }

      try {
        const tx = conn.transaction(storeName, "readwrite");
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (e) {
        resolve();
      }
    });
  }

  async function dbSaveBatch(storeName, items, batchSize = 25) {
    if (!Array.isArray(items) || items.length === 0) return true;
    const conn = await ensureDb();
    if (!conn) {
      for (let i = 0; i < items.length; i++) {
        if (items[i]) putInMemoryStore(storeName, items[i]);
      }
      return true;
    }
    let allOk = true;
    for (let i = 0; i < items.length; i += batchSize) {
      const chunk = items.slice(i, i + batchSize);
      const ok = await new Promise((resolve) => {
        let settled = false;
        const finish = (val, err) => {
          if (settled) return;
          settled = true;
          if (!val && isQuotaError(err)) notifyQuotaExceeded();
          resolve(val);
        };
        try {
          const tx = conn.transaction(storeName, "readwrite");
          const store = tx.objectStore(storeName);
          for (let j = 0; j < chunk.length; j++) {
            if (chunk[j]) store.put(chunk[j]);
          }
          tx.oncomplete = () => finish(true);
          tx.onerror = (ev) => finish(false, tx.error || ev?.target?.error);
          tx.onabort = () => finish(false, tx.error);
        } catch (e) {
          finish(false);
        }
      });
      if (!ok) allOk = false;
      if (i + batchSize < items.length) {
        await new Promise(r => setTimeout(r, 0));
      }
    }
    return allOk;
  }

  async function dbGetBatch(storeName, keys) {
    if (!Array.isArray(keys) || keys.length === 0) return [];
    const conn = await ensureDb();
    const keyProp = STORE_KEY_PATHS[storeName] || "key";
    if (!conn) {
      const list = inMemoryDb[storeName] || [];
      const byKey = new Map();
      for (let i = 0; i < list.length; i++) {
        if (list[i]) byKey.set(list[i][keyProp], list[i]);
      }
      return keys.map(k => byKey.get(k) || null);
    }
    return new Promise((resolve) => {
      try {
        const tx = conn.transaction(storeName, "readonly");
        const store = tx.objectStore(storeName);
        const results = new Array(keys.length).fill(null);
        for (let i = 0; i < keys.length; i++) {
          const req = store.get(keys[i]);
          req.onsuccess = () => { results[i] = req.result || null; };
          req.onerror = () => { results[i] = null; };
        }
        tx.oncomplete = () => resolve(results);
        tx.onerror = () => resolve(results);
        tx.onabort = () => resolve(results);
      } catch (e) {
        resolve(new Array(keys.length).fill(null));
      }
    });
  }

  async function dbDeleteBatch(storeName, keys, batchSize = 40) {
    if (!Array.isArray(keys) || keys.length === 0) return;
    const keyProp = STORE_KEY_PATHS[storeName] || "key";
    if (inMemoryDb[storeName]) {
      const delSet = new Set(keys);
      inMemoryDb[storeName] = inMemoryDb[storeName].filter(x => x && !delSet.has(x[keyProp]));
    }
    const conn = await ensureDb();
    if (!conn) return;
    for (let i = 0; i < keys.length; i += batchSize) {
      const chunk = keys.slice(i, i + batchSize);
      await new Promise((resolve) => {
        try {
          const tx = conn.transaction(storeName, "readwrite");
          const store = tx.objectStore(storeName);
          for (let j = 0; j < chunk.length; j++) {
            store.delete(chunk[j]);
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch (e) {
          resolve();
        }
      });
    }
  }

  // Asset / ObjectURL management
  function revokeBookObjectUrls(bookIdPrefix) {
    for (const [key, url] of activeObjectUrls.entries()) {
      if (!bookIdPrefix || key.startsWith(bookIdPrefix)) {
        try { URL.revokeObjectURL(url); } catch (e) {}
        activeObjectUrls.delete(key);
      }
    }
  }

  async function resolveBookAssetUrl(assetKey) {
    if (!assetKey) return "";
    if (activeObjectUrls.has(assetKey)) return activeObjectUrls.get(assetKey);
    const rec = await dbGet("bookAssets", assetKey);
    if (!rec) return "";
    try {
      if (rec.buffer) {
        const blob = new Blob([rec.buffer], { type: rec.mimeType || "image/jpeg" });
        const objUrl = URL.createObjectURL(blob);
        activeObjectUrls.set(assetKey, objUrl);
        return objUrl;
      }
      if (rec.blob instanceof Blob) {
        const objUrl = URL.createObjectURL(rec.blob);
        activeObjectUrls.set(assetKey, objUrl);
        return objUrl;
      }
    } catch (e) {}
    return "";
  }

  async function hydrateChapterImages(containerEl) {
    if (!containerEl) return;
    const assetImgs = Array.from(containerEl.querySelectorAll("[data-nyx-asset], [data-lumina-asset]"));
    if (assetImgs.length === 0) return;

    const missingKeys = [];
    const seenMissing = new Set();
    for (let i = 0; i < assetImgs.length; i++) {
      const key = assetImgs[i].getAttribute("data-nyx-asset") || assetImgs[i].getAttribute("data-lumina-asset");
      if (key && !activeObjectUrls.has(key) && !seenMissing.has(key)) {
        seenMissing.add(key);
        missingKeys.push(key);
      }
    }

    if (missingKeys.length > 0) {
      const records = await dbGetBatch("bookAssets", missingKeys);
      for (let i = 0; i < missingKeys.length; i++) {
        const rec = records[i];
        if (!rec) continue;
        try {
          let objUrl = "";
          if (rec.buffer) {
            const safeMime = (globalScope.NyxenSanitizer && typeof globalScope.NyxenSanitizer.normalizeAssetMimeType === "function")
              ? globalScope.NyxenSanitizer.normalizeAssetMimeType(rec.mimeType, "image/jpeg")
              : (rec.mimeType || "image/jpeg");
            const blob = new Blob([rec.buffer], { type: safeMime });
            objUrl = URL.createObjectURL(blob);
          } else if (rec.blob instanceof Blob) {
            objUrl = URL.createObjectURL(rec.blob);
          }
          if (objUrl) activeObjectUrls.set(missingKeys[i], objUrl);
        } catch (e) {}
      }
    }

    for (let i = 0; i < assetImgs.length; i++) {
      const el = assetImgs[i];
      if (!el.isConnected) continue;
      const key = el.getAttribute("data-nyx-asset") || el.getAttribute("data-lumina-asset");
      const url = key ? activeObjectUrls.get(key) : "";
      if (url) {
        if (el.tagName.toLowerCase() === "image") {
          el.setAttribute("xlink:href", url);
          el.setAttribute("href", url);
        } else {
          el.setAttribute("src", url);
        }
        el.removeAttribute("data-nyx-asset");
        el.removeAttribute("data-lumina-asset");
        el.removeAttribute("data-nyx-blocked-badge");
      }
    }
  }

  // Book collections & metadata repository
  function getBookCollections(book) {
    if (!book) return [];
    const raw = Array.isArray(book.groups)
      ? book.groups
      : (typeof book.group === "string" && book.group.trim() ? [book.group] : []);
    const seen = new Set();
    const result = [];
    for (const item of raw) {
      const name = String(item || "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        result.push(name);
      }
    }
    return result;
  }

  function setBookCollections(book, collections) {
    if (!book) return [];
    const clean = getBookCollections({ groups: collections });
    if (clean.length > 0) {
      book.groups = clean;
      book.group = clean[0];
    } else {
      delete book.groups;
      delete book.group;
    }
    return clean;
  }

  function getAllLibraryCollections() {
    const seen = new Map();
    const booksList = hooks.getBooksList() || [];
    for (const b of booksList) {
      for (const col of getBookCollections(b)) {
        const key = col.toLowerCase();
        if (!seen.has(key)) seen.set(key, col);
      }
    }
    return Array.from(seen.values());
  }

  const PROGRESS_FIELDS = [
    "currentChapter",
    "chapterScrollRatio",
    "chapterAnchor",
    "hasStartedReading",
    "progressRevision",
    "progressSeq",
    "progressSessionId",
    "progressUpdatedAt"
  ];

  function sanitizeRatingValue(rating) {
    return typeof rating === "number" && rating > 0
      ? Math.min(5, Math.max(0.5, Math.round(rating * 2) / 2))
      : 0;
  }

  function buildMetaRecord(book) {
    const cols = getBookCollections(book);
    const metaRecord = {
      id: book.id,
      title: book.title,
      author: book.author,
      language: book.language || "",
      description: book.description,
      tags: Array.isArray(book.tags) ? book.tags : [],
      cover: book.cover,
      totalChapters: book.totalChapters,
      currentChapter: book.currentChapter || 0,
      chapterScrollRatio: book.chapterScrollRatio || 0,
      chapterAnchor: book.chapterAnchor && typeof book.chapterAnchor === "object" ? book.chapterAnchor : null,
      hasStartedReading: Boolean(book.hasStartedReading),
      allowExternalResources: Boolean(book.allowExternalResources),
      status: book.status || "Leyendo",
      group: cols[0],
      groups: cols.length > 0 ? cols : undefined,
      addedAt: book.addedAt || Date.now(),
      lastOpenedAt: book.lastOpenedAt || 0,
      rating: sanitizeRatingValue(book.rating),
      review: typeof book.review === "string" ? book.review : "",
      reviewedAt: typeof book.reviewedAt === "number" ? book.reviewedAt : 0,
      highlights: book.highlights || [],
      chapterWordCounts: Array.isArray(book.chapterWordCounts) ? book.chapterWordCounts : undefined,
      favoriteChapters: Array.isArray(book.chapters)
        ? book.chapters.filter(c => c.isFavorite).map(c => c.index)
        : (book.favoriteChapters || [])
    };
    if (typeof book.progressRevision === "number" && Number.isFinite(book.progressRevision)) {
      metaRecord.progressRevision = book.progressRevision;
    }
    if (typeof book.progressSeq === "number" && Number.isFinite(book.progressSeq)) {
      metaRecord.progressSeq = book.progressSeq;
    }
    if (typeof book.progressSessionId === "string" && book.progressSessionId) {
      metaRecord.progressSessionId = book.progressSessionId;
    }
    if (typeof book.progressUpdatedAt === "number" && Number.isFinite(book.progressUpdatedAt)) {
      metaRecord.progressUpdatedAt = book.progressUpdatedAt;
    }
    return metaRecord;
  }

  function syncBookCachesAfterCommit(record, options = {}) {
    if (!record || !record.id) return;
    registerBookDiskRevision(record);

    const forceSyncProgress = Boolean(options.forceSyncProgress);
    const preserveNewerInMemoryProgress = Boolean(options.preserveNewerInMemoryProgress);

    const mergeIntoTarget = (target) => {
      if (!target || target.id !== record.id) return;
      const preservedChapters = target.chapters;
      const preservedFootnotes = target.footnotes;
      const prevProg = {
        currentChapter: target.currentChapter,
        chapterScrollRatio: target.chapterScrollRatio,
        chapterAnchor: target.chapterAnchor,
        hasStartedReading: target.hasStartedReading,
        progressRevision: target.progressRevision,
        progressSeq: target.progressSeq,
        progressSessionId: target.progressSessionId,
        progressUpdatedAt: target.progressUpdatedAt
      };
      Object.assign(target, record);
      if (record.group === undefined) delete target.group;
      if (record.groups === undefined) delete target.groups;
      if (record.chapterWordCounts === undefined) delete target.chapterWordCounts;
      if (preserveNewerInMemoryProgress && !forceSyncProgress) {
        const memSeq = typeof prevProg.progressSeq === "number" ? prevProg.progressSeq : 0;
        const recSeq = typeof record.progressSeq === "number" ? record.progressSeq : 0;
        const memRev = typeof prevProg.progressRevision === "number" ? prevProg.progressRevision : 0;
        const recRev = typeof record.progressRevision === "number" ? record.progressRevision : 0;
        if (prevProg.progressSessionId === STORAGE_SESSION_ID && (memSeq > recSeq || memRev > recRev)) {
          target.currentChapter = prevProg.currentChapter;
          target.chapterScrollRatio = prevProg.chapterScrollRatio;
          target.chapterAnchor = prevProg.chapterAnchor;
          target.hasStartedReading = prevProg.hasStartedReading;
          target.progressRevision = prevProg.progressRevision;
          target.progressSeq = prevProg.progressSeq;
          target.progressSessionId = prevProg.progressSessionId;
          target.progressUpdatedAt = prevProg.progressUpdatedAt;
        }
      }
      if (Array.isArray(preservedChapters) && preservedChapters.length > 0) {
        target.chapters = preservedChapters;
      }
      if (preservedFootnotes) {
        target.footnotes = preservedFootnotes;
      }
    };

    const booksList = hooks.getBooksList();
    if (Array.isArray(booksList)) {
      const idx = booksList.findIndex(b => b && b.id === record.id);
      if (idx !== -1) {
        mergeIntoTarget(booksList[idx]);
      } else {
        booksList.push({ ...record });
      }
    }

    const currentBook = hooks.getCurrentBook();
    if (currentBook && currentBook.id === record.id) {
      mergeIntoTarget(currentBook);
    }
  }

  function enqueueBookWrite(bookId, taskFn) {
    const prevTail = bookWriteQueues.get(bookId) || Promise.resolve();
    const taskPromise = prevTail
      .catch(() => {}) // Aísla fallos anteriores para no bloquear futuras escrituras del mismo libro
      .then(() => taskFn());

    const safeTail = taskPromise.catch(() => {}).finally(() => {
      if (bookWriteQueues.get(bookId) === safeTail) {
        bookWriteQueues.delete(bookId);
      }
    });
    bookWriteQueues.set(bookId, safeTail);
    return taskPromise;
  }

  /**
   * Ejecuta lectura (store.get), fusión estrictamente síncrona (mergeFn) y escritura (store.put)
   * dentro de la MISMA transacción readwrite en IndexedDB.
   * Garantiza distinguir transacción completada sin put() ("skipped: true, persistedToIdb: false")
   * frente a escritura realmente confirmada mediante store.put() + tx.oncomplete ("persistedToIdb: true").
   */
  async function dbUpdateBookInTransaction(bookId, mergeFn, options = {}) {
    if (!bookId || typeof mergeFn !== "function") {
      return {
        ok: false,
        persistedToIdb: false,
        persistedToMemory: false,
        writtenToIdb: false,
        skipped: false,
        reason: "invalid-args",
        record: null
      };
    }

    return enqueueBookWrite(bookId, async () => {
      if (deletedBookIdsInSession.has(bookId) && !options.allowCreate) {
        return {
          ok: true,
          persistedToIdb: false,
          persistedToMemory: false,
          writtenToIdb: false,
          skipped: true,
          reason: "deleted-in-session",
          record: null
        };
      }

      let conn = await ensureDb();
      if (!conn) {
        // Fallback temporal en RAM (nunca confirma persistedToIdb)
        const list = inMemoryDb.books || [];
        const existingMem = list.find(x => x && x.id === bookId) || null;
        let decision;
        try {
          decision = mergeFn(existingMem ? { ...existingMem } : null);
        } catch (err) {
          return {
            ok: false,
            persistedToIdb: false,
            persistedToMemory: false,
            writtenToIdb: false,
            skipped: false,
            reason: "merge-error",
            error: err,
            record: null
          };
        }
        if (!decision || decision.skip) {
          return {
            ok: true,
            persistedToIdb: false,
            persistedToMemory: false,
            writtenToIdb: false,
            skipped: true,
            reason: (decision && decision.reason) || "skipped",
            record: (decision && decision.record) || existingMem
          };
        }
        if (decision.record) {
          putInMemoryStore("books", decision.record);
          syncBookCachesAfterCommit(decision.record, options);
        }
        return {
          ok: true,
          persistedToIdb: false,
          persistedToMemory: true,
          writtenToIdb: false,
          skipped: false,
          reason: "memory-fallback",
          record: decision.record || null
        };
      }

      const runTx = (targetConn) => new Promise((resolve) => {
        let settled = false;
        let didPut = false;
        let skipReason = null;
        let finalRecord = null;
        let mergeError = null;

        const finish = (res) => {
          if (settled) return;
          settled = true;
          resolve(res);
        };

        try {
          const tx = targetConn.transaction("books", "readwrite");
          const store = tx.objectStore("books");
          const getReq = store.get(bookId);

          getReq.onsuccess = () => {
            const diskRecord = getReq.result || null;
            let decision;
            try {
              // ESTRICTAMENTE SÍNCRONO dentro del callback onsuccess de store.get()
              decision = mergeFn(diskRecord);
            } catch (err) {
              mergeError = err;
              try { tx.abort(); } catch (abortErr) {}
              return;
            }

            if (!decision || decision.skip || !decision.record) {
              didPut = false;
              skipReason = (decision && decision.reason) || "skipped";
              finalRecord = (decision && decision.record) || diskRecord;
              return;
            }

            didPut = true;
            finalRecord = decision.record;
            const putReq = store.put(finalRecord);
            putReq.onerror = () => {
              // Manejado por tx.onerror / tx.onabort
            };
          };

          getReq.onerror = () => {
            const err = getReq.error;
            if (!settled) {
              try { tx.abort(); } catch (abortErr) {}
              finish({
                ok: false,
                persistedToIdb: false,
                persistedToMemory: false,
                writtenToIdb: false,
                skipped: false,
                aborted: true,
                retryableInvalidState: handleTransactionFailureAndMaybeReset(targetConn, err),
                error: err,
                record: null
              });
            }
          };

          tx.oncomplete = () => {
            if (!didPut) {
              finish({
                ok: true,
                persistedToIdb: false,
                persistedToMemory: false,
                writtenToIdb: false,
                skipped: true,
                reason: skipReason || "skipped",
                record: finalRecord
              });
              return;
            }
            if (finalRecord) {
              putInMemoryStore("books", finalRecord);
              syncBookCachesAfterCommit(finalRecord, options);
            }
            finish({
              ok: true,
              persistedToIdb: true,
              persistedToMemory: false,
              writtenToIdb: true,
              skipped: false,
              reason: null,
              record: finalRecord
            });
          };

          tx.onerror = (ev) => {
            const err = mergeError || tx.error || ev?.target?.error;
            if (isQuotaError(err)) notifyQuotaExceeded();
            const retryable = handleTransactionFailureAndMaybeReset(targetConn, err);
            finish({
              ok: false,
              persistedToIdb: false,
              persistedToMemory: false,
              writtenToIdb: false,
              skipped: false,
              aborted: true,
              quotaExceeded: isQuotaError(err),
              retryableInvalidState: retryable,
              error: err,
              record: null
            });
          };

          tx.onabort = () => {
            const err = mergeError || tx.error;
            if (isQuotaError(err)) notifyQuotaExceeded();
            const retryable = handleTransactionFailureAndMaybeReset(targetConn, err);
            finish({
              ok: false,
              persistedToIdb: false,
              persistedToMemory: false,
              writtenToIdb: false,
              skipped: false,
              aborted: true,
              quotaExceeded: isQuotaError(err),
              retryableInvalidState: retryable,
              error: err,
              record: null
            });
          };
        } catch (err) {
          const retryable = handleTransactionFailureAndMaybeReset(targetConn, err);
          finish({
            ok: false,
            persistedToIdb: false,
            persistedToMemory: false,
            writtenToIdb: false,
            skipped: false,
            aborted: false,
            quotaExceeded: isQuotaError(err),
            retryableInvalidState: retryable,
            error: err,
            record: null
          });
        }
      });

      let res = await runTx(conn);
      if (!res.ok && res.retryableInvalidState) {
        resetRetryCooldown();
        conn = await ensureDb();
        if (conn) {
          res = await runTx(conn);
        }
      }
      return res;
    });
  }

  function nextBookProgressSeq(bookId, minFloor = 0) {
    const prev = bookSeqCounters.get(bookId) || 0;
    const next = Math.max(prev, minFloor) + 1;
    bookSeqCounters.set(bookId, next);
    return next;
  }

  /**
   * Actualización secundaria estrictamente parcial: fusiona únicamente los campos provistos
   * sobre el registro real leído dentro de la transacción, sin tocar progreso de lectura.
   */
  async function saveBookPatch(bookId, patch, options = {}) {
    if (!bookId || !patch || typeof patch !== "object") {
      return { ok: false, persistedToIdb: false, persistedToMemory: false, writtenToIdb: false, skipped: false };
    }
    const cleanPatch = { ...patch };
    for (let i = 0; i < PROGRESS_FIELDS.length; i++) {
      delete cleanPatch[PROGRESS_FIELDS[i]];
    }

    return dbUpdateBookInTransaction(
      bookId,
      (diskRecord) => {
        const base = diskRecord
          ? { ...diskRecord }
          : (options.fallbackBook ? buildMetaRecord(options.fallbackBook) : null);
        if (!base) {
          return { skip: true, reason: "missing-book" };
        }
        const entries = Object.entries(cleanPatch);
        for (let i = 0; i < entries.length; i++) {
          const k = entries[i][0];
          const v = entries[i][1];
          if (k === "rating") {
            base.rating = sanitizeRatingValue(v);
          } else if (v === undefined) {
            delete base[k];
          } else {
            base[k] = v;
          }
        }
        if (Array.isArray(base.groups) && base.groups.length > 0) {
          base.group = base.groups[0];
        } else if (Object.prototype.hasOwnProperty.call(cleanPatch, "groups") && !(Array.isArray(cleanPatch.groups) && cleanPatch.groups.length > 0)) {
          delete base.groups;
          delete base.group;
        }
        return { skip: false, record: base };
      },
      {
        allowCreate: Boolean(options.fallbackBook),
        preserveNewerInMemoryProgress: true,
        forceSyncProgress: false
      }
    );
  }

  /**
   * Actualización de progreso de lectura con guarda optimista multi-pestaña (progressRevision)
   * y conservación de parches pendientes en pendingRecoveryProgressPatches si IDB no está disponible.
   */
  async function saveBookProgressPatch(bookId, progressPatch, options = {}) {
    if (!bookId || !progressPatch || typeof progressPatch !== "object") {
      return { ok: false, persistedToIdb: false, persistedToMemory: false, writtenToIdb: false, skipped: false };
    }

    const baseRevisionKnown = options.baseRevisionKnown !== undefined
      ? Boolean(options.baseRevisionKnown)
      : knownDiskRevisionByBook.has(bookId);
    const expectedBaseRevision = baseRevisionKnown
      ? (options.expectedBaseRevision !== undefined ? options.expectedBaseRevision : knownDiskRevisionByBook.get(bookId))
      : null;

    const incomingSeq = typeof progressPatch.progressSeq === "number"
      ? progressPatch.progressSeq
      : nextBookProgressSeq(bookId);
    const incomingTs = typeof progressPatch.progressUpdatedAt === "number"
      ? progressPatch.progressUpdatedAt
      : nextMonotonicProgressTimestamp();
    const isRecoveryDrain = Boolean(options.isRecoveryDrain);

    const preparedPatch = {
      currentChapter: typeof progressPatch.currentChapter === "number" ? progressPatch.currentChapter : undefined,
      chapterScrollRatio: typeof progressPatch.chapterScrollRatio === "number" ? progressPatch.chapterScrollRatio : undefined,
      chapterAnchor: progressPatch.chapterAnchor !== undefined ? progressPatch.chapterAnchor : undefined,
      hasStartedReading: progressPatch.hasStartedReading !== undefined ? Boolean(progressPatch.hasStartedReading) : undefined,
      lastOpenedAt: typeof progressPatch.lastOpenedAt === "number" ? progressPatch.lastOpenedAt : undefined,
      progressSeq: incomingSeq,
      progressSessionId: progressPatch.progressSessionId || STORAGE_SESSION_ID,
      progressUpdatedAt: incomingTs,
      expectedBaseRevision,
      baseRevisionKnown,
      explicitUserChapterSwitch: Boolean(options.explicitUserChapterSwitch)
    };

    const res = await dbUpdateBookInTransaction(
      bookId,
      (diskRecord) => {
        if (!diskRecord) {
          if (isRecoveryDrain || !options.fallbackBook) {
            return { skip: true, reason: isRecoveryDrain ? "recovery-missing-book" : "missing-book" };
          }
        }

        const base = diskRecord ? { ...diskRecord } : buildMetaRecord(options.fallbackBook);
        const diskRev = typeof base.progressRevision === "number" && Number.isFinite(base.progressRevision)
          ? base.progressRevision
          : 0;
        const diskSeq = typeof base.progressSeq === "number" && Number.isFinite(base.progressSeq)
          ? base.progressSeq
          : 0;
        const diskSess = base.progressSessionId || null;

        if (isRecoveryDrain) {
          if (!preparedPatch.baseRevisionKnown) {
            const hasDiskProgress = Boolean(
              base.hasStartedReading ||
              (base.currentChapter || 0) > 0 ||
              (base.chapterScrollRatio || 0) > 0 ||
              diskRev > 0
            );
            if (hasDiskProgress) {
              return { skip: true, reason: "recovery-disk-has-progress", record: base };
            }
          } else {
            if (diskSess && diskSess !== STORAGE_SESSION_ID && diskRev > (preparedPatch.expectedBaseRevision || 0)) {
              return { skip: true, reason: "external-revision-conflict", record: base };
            }
            if (diskSess === STORAGE_SESSION_ID && diskSeq >= preparedPatch.progressSeq) {
              return { skip: true, reason: "stale-in-session", record: base };
            }
          }
        } else if (diskRecord) {
          if (
            diskSess &&
            diskSess !== STORAGE_SESSION_ID &&
            preparedPatch.baseRevisionKnown &&
            diskRev > (preparedPatch.expectedBaseRevision || 0)
          ) {
            return { skip: true, reason: "external-revision-conflict", record: base };
          }
          if (diskSess === STORAGE_SESSION_ID && diskSeq >= preparedPatch.progressSeq) {
            return { skip: true, reason: "stale-in-session", record: base };
          }
        }

        if (preparedPatch.currentChapter !== undefined) base.currentChapter = preparedPatch.currentChapter;
        if (preparedPatch.chapterScrollRatio !== undefined) base.chapterScrollRatio = preparedPatch.chapterScrollRatio;
        if (preparedPatch.chapterAnchor !== undefined) base.chapterAnchor = preparedPatch.chapterAnchor;
        if (preparedPatch.hasStartedReading !== undefined) base.hasStartedReading = preparedPatch.hasStartedReading;
        if (preparedPatch.lastOpenedAt !== undefined) {
          base.lastOpenedAt = Math.max(base.lastOpenedAt || 0, preparedPatch.lastOpenedAt);
        }

        const nextRev = Math.max(diskRev, preparedPatch.expectedBaseRevision || 0) + 1;
        base.progressRevision = nextRev;
        base.progressSeq = preparedPatch.progressSeq;
        base.progressSessionId = preparedPatch.progressSessionId;
        base.progressUpdatedAt = preparedPatch.progressUpdatedAt;

        return { skip: false, record: base };
      },
      {
        allowCreate: Boolean(options.fallbackBook && !isRecoveryDrain),
        forceSyncProgress: true,
        isProgressWrite: true
      }
    );

    if (res.skipped && res.reason === "external-revision-conflict" && res.record) {
      syncBookCachesAfterCommit(res.record, { forceSyncProgress: true });
      if (typeof hooks.onExternalProgressConflict === "function") {
        try {
          hooks.onExternalProgressConflict({
            bookId,
            diskRecord: res.record,
            attemptedPatch: preparedPatch
          });
        } catch (e) {}
      }
    } else if (res.skipped && res.reason === "recovery-disk-has-progress" && res.record) {
      syncBookCachesAfterCommit(res.record, { forceSyncProgress: true });
    }

    // Si falló IDB o cayó a RAM temporal (y no es ya un drenado conflictivo/descartado), conservar en pendingRecoveryProgressPatches
    if (!res.persistedToIdb && !res.skipped && !isRecoveryDrain) {
      const existingPending = pendingRecoveryProgressPatches.get(bookId);
      if (!existingPending || preparedPatch.progressSeq >= existingPending.progressSeq) {
        pendingRecoveryProgressPatches.set(bookId, preparedPatch);
      }
    } else if (res.persistedToIdb && isRecoveryDrain) {
      pendingRecoveryProgressPatches.delete(bookId);
    } else if (res.skipped && isRecoveryDrain) {
      pendingRecoveryProgressPatches.delete(bookId);
    } else if (res.persistedToIdb && !isRecoveryDrain) {
      const curPending = pendingRecoveryProgressPatches.get(bookId);
      if (curPending && curPending.progressSeq <= preparedPatch.progressSeq) {
        pendingRecoveryProgressPatches.delete(bookId);
      }
    }

    return res;
  }

  async function drainPendingRecoveryProgressPatches() {
    if (!db || pendingRecoveryProgressPatches.size === 0) return [];
    const entries = Array.from(pendingRecoveryProgressPatches.entries());
    const results = [];
    for (let i = 0; i < entries.length; i++) {
      const bookId = entries[i][0];
      const patch = entries[i][1];
      if (!patch) {
        pendingRecoveryProgressPatches.delete(bookId);
        continue;
      }
      const res = await saveBookProgressPatch(bookId, patch, {
        isRecoveryDrain: true,
        baseRevisionKnown: patch.baseRevisionKnown,
        expectedBaseRevision: patch.expectedBaseRevision
      });
      results.push({ bookId, res });
      if (typeof hooks.onRecoverySync === "function") {
        try {
          hooks.onRecoverySync({ bookId, res });
        } catch (e) {}
      }
    }
    return results;
  }

  async function saveBookMeta(book, options = {}) {
    if (!book || !book.id) return false;

    if (Array.isArray(options.fields) && options.fields.length > 0) {
      const fullRec = buildMetaRecord(book);
      const patch = {};
      for (let i = 0; i < options.fields.length; i++) {
        const key = options.fields[i];
        patch[key] = fullRec[key];
      }
      const res = await saveBookPatch(book.id, patch, { fallbackBook: book });
      return Boolean(res.ok);
    }

    const allowProgressOverwrite = Boolean(options.allowProgressOverwrite || options.kind === "full" || options.kind === "backup_merge");
    const fullRec = buildMetaRecord(book);
    if (allowProgressOverwrite) {
      deletedBookIdsInSession.delete(book.id);
    }

    const expectedBase = knownDiskRevisionByBook.has(book.id) ? knownDiskRevisionByBook.get(book.id) : null;
    const seq = nextBookProgressSeq(book.id);
    const ts = nextMonotonicProgressTimestamp();

    const res = await dbUpdateBookInTransaction(
      book.id,
      (diskRecord) => {
        if (!diskRecord) {
          fullRec.progressRevision = 1;
          fullRec.progressSeq = seq;
          fullRec.progressSessionId = STORAGE_SESSION_ID;
          fullRec.progressUpdatedAt = ts;
          return { skip: false, record: fullRec };
        }

        const diskRev = typeof diskRecord.progressRevision === "number" ? diskRecord.progressRevision : 0;
        const merged = { ...diskRecord, ...fullRec };
        if (fullRec.group === undefined) delete merged.group;
        if (fullRec.groups === undefined) delete merged.groups;
        if (fullRec.chapterWordCounts === undefined) {
          if (diskRecord.chapterWordCounts !== undefined) merged.chapterWordCounts = diskRecord.chapterWordCounts;
          else delete merged.chapterWordCounts;
        }

        if (!allowProgressOverwrite) {
          const isDiskNewerOrEqual = (
            diskRecord.progressSessionId &&
            diskRecord.progressSessionId !== STORAGE_SESSION_ID &&
            (expectedBase === null || diskRev > expectedBase)
          ) || (
            diskRecord.progressSessionId === STORAGE_SESSION_ID &&
            (diskRecord.progressSeq || 0) >= (book.progressSeq || 0)
          );
          if (isDiskNewerOrEqual) {
            merged.currentChapter = diskRecord.currentChapter;
            merged.chapterScrollRatio = diskRecord.chapterScrollRatio;
            merged.chapterAnchor = diskRecord.chapterAnchor;
            merged.hasStartedReading = diskRecord.hasStartedReading;
            merged.progressRevision = diskRecord.progressRevision;
            merged.progressSeq = diskRecord.progressSeq;
            merged.progressSessionId = diskRecord.progressSessionId;
            merged.progressUpdatedAt = diskRecord.progressUpdatedAt;
            return { skip: false, record: merged };
          }
        }

        merged.progressRevision = Math.max(diskRev, expectedBase || 0) + 1;
        merged.progressSeq = seq;
        merged.progressSessionId = STORAGE_SESSION_ID;
        merged.progressUpdatedAt = ts;
        return { skip: false, record: merged };
      },
      {
        allowCreate: true,
        forceSyncProgress: allowProgressOverwrite,
        preserveNewerInMemoryProgress: !allowProgressOverwrite
      }
    );
    return Boolean(res.ok);
  }

  async function saveFullBookToDb(bookData, assetBlobs = []) {
    if (!bookData || !bookData.id) return false;
    deletedBookIdsInSession.delete(bookData.id);
    const removeFromBooksList = (bookId) => {
      const list = hooks.getBooksList();
      if (Array.isArray(list)) {
        hooks.setBooksList(list.filter(b => b && b.id !== bookId));
      }
    };

    if (Array.isArray(assetBlobs) && assetBlobs.length > 0) {
      const assetBatch = [];
      for (let i = 0; i < assetBlobs.length; i++) {
        const asset = assetBlobs[i];
        if (!asset || !asset.assetKey) continue;
        assetBatch.push({
          assetKey: asset.assetKey,
          bookId: bookData.id,
          buffer: asset.buffer || null,
          mimeType: asset.mimeType || "image/jpeg"
        });
        assetBlobs[i] = null;
      }
      if (assetBatch.length > 0) {
        const assetsSaved = await dbSaveBatch("bookAssets", assetBatch, 16);
        if (!assetsSaved) {
          await deleteBookAndAssets(bookData.id).catch(() => {});
          removeFromBooksList(bookData.id);
          return false;
        }
      }
    }

    const chapters = Array.isArray(bookData.chapters) ? bookData.chapters : [];
    let contentSaved = false;
    if (chapters.length > CHAPTER_CHUNK_SIZE) {
      const chunkCount = Math.ceil(chapters.length / CHAPTER_CHUNK_SIZE);
      const contentBatch = [];
      for (let c = 0; c < chunkCount; c++) {
        const slice = chapters.slice(c * CHAPTER_CHUNK_SIZE, (c + 1) * CHAPTER_CHUNK_SIZE);
        contentBatch.push({
          bookId: `${bookData.id}__chunk_${c}`,
          chapters: slice
        });
      }
      contentBatch.push({
        bookId: bookData.id,
        chunkCount,
        chapters: [],
        footnotes: bookData.footnotes || {}
      });
      contentSaved = await dbSaveBatch("bookContents", contentBatch, 10);
    } else {
      contentSaved = await dbSave("bookContents", {
        bookId: bookData.id,
        chunkCount: 0,
        chapters,
        footnotes: bookData.footnotes || {}
      });
    }

    if (!contentSaved) {
      await deleteBookAndAssets(bookData.id).catch(() => {});
      removeFromBooksList(bookData.id);
      return false;
    }

    const metaSaved = await saveBookMeta(bookData, { allowProgressOverwrite: true, kind: "full" });
    if (!metaSaved) {
      await deleteBookAndAssets(bookData.id).catch(() => {});
      removeFromBooksList(bookData.id);
      return false;
    }
    return true;
  }

  function releaseBookHeavyMemory(bookIdToFree, keepBookObj = null) {
    if (!bookIdToFree) return;
    revokeBookObjectUrls(`${bookIdToFree}::`);
    const booksList = hooks.getBooksList();
    if (Array.isArray(booksList)) {
      const listMatch = booksList.find(b => b && b.id === bookIdToFree);
      if (listMatch && listMatch !== keepBookObj) {
        listMatch.chapters = [];
        listMatch.footnotes = {};
      }
    }
  }

  function releaseLastHydratedBook() {
    if (lastHydratedBookId) {
      releaseBookHeavyMemory(lastHydratedBookId);
      lastHydratedBookId = null;
    }
  }

  function resetHydrationState() {
    lastHydratedBookId = null;
  }

  async function ensureBookHydrated(book) {
    if (!book) return null;
    if (lastHydratedBookId && lastHydratedBookId !== book.id) {
      releaseBookHeavyMemory(lastHydratedBookId, book);
    }
    if (!Array.isArray(book.chapters) || book.chapters.length === 0) {
      const contentRec = await dbGet("bookContents", book.id);
      if (contentRec) {
        if (contentRec.chunkCount && contentRec.chunkCount > 0) {
          const chunkKeys = [];
          for (let c = 0; c < contentRec.chunkCount; c++) {
            chunkKeys.push(`${book.id}__chunk_${c}`);
          }
          const chunkRecords = await dbGetBatch("bookContents", chunkKeys);
          const merged = [];
          for (let c = 0; c < chunkRecords.length; c++) {
            const chRec = chunkRecords[c];
            if (chRec && Array.isArray(chRec.chapters)) {
              for (let k = 0; k < chRec.chapters.length; k++) {
                merged.push(chRec.chapters[k]);
              }
            }
          }
          book.chapters = merged;
        } else {
          book.chapters = contentRec.chapters || [];
        }
        book.footnotes = contentRec.footnotes || {};
      } else {
        book.chapters = [];
        book.footnotes = {};
      }
    }
    lastHydratedBookId = book.id;
    if (Array.isArray(book.favoriteChapters) && Array.isArray(book.chapters)) {
      const favSet = new Set(book.favoriteChapters);
      book.chapters.forEach(c => {
        c.isFavorite = favSet.has(c.index) || Boolean(c.isFavorite);
      });
    }
    return book;
  }

  async function deleteBookAndAssets(bookId) {
    deletedBookIdsInSession.add(bookId);
    pendingRecoveryProgressPatches.delete(bookId);
    knownDiskRevisionByBook.delete(bookId);
    bookSeqCounters.delete(bookId);
    const tail = bookWriteQueues.get(bookId);
    if (tail) {
      await tail.catch(() => {});
    }
    revokeBookObjectUrls(`${bookId}::`);
    if (typeof hooks.onRevokeCover === "function") {
      try { hooks.onRevokeCover(bookId); } catch (e) {}
    }
    if (typeof hooks.onBeforeDeleteBook === "function") {
      try { hooks.onBeforeDeleteBook(bookId); } catch (e) {}
    }
    const contentRec = await dbGet("bookContents", bookId);
    const contentKeysToDelete = [bookId];
    if (contentRec && contentRec.chunkCount > 0) {
      for (let c = 0; c < contentRec.chunkCount; c++) {
        contentKeysToDelete.push(`${bookId}__chunk_${c}`);
      }
    }
    await dbDeleteBatch("bookContents", contentKeysToDelete, 40);
    await dbDelete("books", bookId);
    await dbDelete("settings", `bookSearchHistory_${bookId}`);
    const assetKeys = await dbGetAllKeys("bookAssets");
    const matchingAssetKeys = assetKeys.filter(key => String(key).startsWith(`${bookId}::`));
    if (matchingAssetKeys.length > 0) {
      await dbDeleteBatch("bookAssets", matchingAssetKeys, 40);
    }
    if (lastHydratedBookId === bookId) {
      lastHydratedBookId = null;
    }
  }

  // Domain repositories over existing IndexedDB stores
  const settingsRepo = {
    get: async (key, fallback = null) => {
      const rec = await dbGet("settings", key);
      return rec && rec.val !== undefined ? rec.val : fallback;
    },
    getRecord: (key) => dbGet("settings", key),
    save: (key, val) => dbSave("settings", { key, val }),
    saveRecord: (record) => dbSave("settings", record),
    getAll: () => dbGetAll("settings"),
    getAllKeys: () => dbGetAllKeys("settings"),
    remove: (key) => dbDelete("settings", key),
    removeBatch: (keys, batchSize = 40) => dbDeleteBatch("settings", keys, batchSize)
  };

  const themesRepo = {
    getAll: () => dbGetAll("themes"),
    save: (theme) => dbSave("themes", theme),
    remove: (themeId) => dbDelete("themes", themeId)
  };

  const fontsRepo = {
    getAll: () => dbGetAll("customFonts"),
    save: (fontRecord) => dbSave("customFonts", fontRecord)
  };

  const swatchesRepo = {
    getAll: () => dbGetAll("swatches"),
    save: (swatchRecord) => dbSave("swatches", swatchRecord)
  };

  const dictRepo = {
    get: (lang) => dbGet("dictPacks", lang),
    save: (record) => dbSave("dictPacks", record),
    remove: (lang) => dbDelete("dictPacks", lang)
  };

  globalScope.NyxenStorage = {
    DB_NAME,
    DB_VERSION,
    STORE_KEY_PATHS,
    CHAPTER_CHUNK_SIZE,
    configure,
    raw: {
      openDatabase,
      ensureDb,
      resetRetryCooldown,
      isUsingTempMemoryStorage,
      isBlocked,
      hasDatabase,
      getSessionId,
      getKnownDiskRevision: (bookId) => (knownDiskRevisionByBook.has(bookId) ? knownDiskRevisionByBook.get(bookId) : null),
      getPendingRecoveryPatchesCount: () => pendingRecoveryProgressPatches.size,
      hasPendingRecoveryPatch: (bookId) => pendingRecoveryProgressPatches.has(bookId),
      drainPendingRecoveryProgressPatches,
      dbUpdateBookInTransaction,
      requestPersistentStorage,
      dbSave,
      dbGet,
      dbGetAll,
      dbGetAllKeys,
      dbClear,
      dbDelete,
      dbSaveBatch,
      dbGetBatch,
      dbDeleteBatch
    },
    books: {
      getAllMeta: () => dbGetAll("books"),
      saveMeta: saveBookMeta,
      savePatch: saveBookPatch,
      saveProgressPatch: saveBookProgressPatch,
      saveFull: saveFullBookToDb,
      ensureHydrated: ensureBookHydrated,
      releaseHeavyMemory: releaseBookHeavyMemory,
      releaseLastHydratedBook,
      resetHydrationState,
      deleteWithAssets: deleteBookAndAssets,
      clearAll: () => dbClear("books"),
      clearContents: () => dbClear("bookContents"),
      getCollections: getBookCollections,
      setCollections: setBookCollections,
      getAllCollections: getAllLibraryCollections
    },
    assets: {
      saveBatch: (items, batchSize = 16) => dbSaveBatch("bookAssets", items, batchSize),
      getAll: () => dbGetAll("bookAssets"),
      getAllKeys: () => dbGetAllKeys("bookAssets"),
      clearAll: () => dbClear("bookAssets"),
      revokeBookObjectUrls,
      resolveBookAssetUrl,
      hydrateChapterImages
    },
    settings: settingsRepo,
    themes: themesRepo,
    fonts: fontsRepo,
    swatches: swatchesRepo,
    dict: dictRepo
  };
})(window);
