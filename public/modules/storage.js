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
  let libraryClearEpoch = 0;

  const DB_OPEN_TIMEOUT_MS = 4500;
  const DB_RETRY_COOLDOWN_MS = 8000;
  const MIRROR_PREFIX = "nyxen_progress_mirror_v1:";
  const PENDING_CLEANUPS_KEY = "pendingAssetCleanups";
  const STORAGE_SESSION_ID = (
    globalScope.crypto && typeof globalScope.crypto.randomUUID === "function"
      ? globalScope.crypto.randomUUID()
      : ("sess_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10))
  );

  const activeObjectUrls = new Map();
  const bookWriteQueues = new Map();
  const knownDiskRevisionByBook = new Map();
  const knownDiskStateByBook = new Map();
  const bookInstanceIdByBook = new Map();
  const bookGenerationByBook = new Map();
  const bookSeqCounters = new Map();
  const pendingRecoveryProgressPatches = new Map();
  const deletedBookIdsInSession = new Set();
  let pendingAssetCleanupsRam = {};

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

  function generateBookInstanceId() {
    if (globalScope.crypto && typeof globalScope.crypto.randomUUID === "function") {
      return `inst_${globalScope.crypto.randomUUID()}`;
    }
    return `inst_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function getBookGeneration(bookId) {
    return bookGenerationByBook.get(bookId) || 0;
  }

  function bumpBookGeneration(bookId) {
    if (!bookId) return 0;
    const next = getBookGeneration(bookId) + 1;
    bookGenerationByBook.set(bookId, next);
    return next;
  }

  function bumpAllTrackedBookGenerations() {
    const allIds = new Set([
      ...bookGenerationByBook.keys(),
      ...bookWriteQueues.keys(),
      ...knownDiskRevisionByBook.keys(),
      ...knownDiskStateByBook.keys(),
      ...bookInstanceIdByBook.keys()
    ]);
    for (const id of allIds) {
      bumpBookGeneration(id);
    }
  }

  function normalizeDiskProgressRecord(record) {
    if (!record || typeof record !== "object") {
      return {
        valid: false,
        rev: 0,
        seq: 0,
        sess: null,
        hasStartedReading: false,
        currentChapter: 0,
        chapterScrollRatio: 0,
        bookInstanceId: null
      };
    }

    let valid = true;

    let rev = 0;
    if (record.progressRevision !== undefined && record.progressRevision !== null) {
      if (typeof record.progressRevision === "number" && Number.isFinite(record.progressRevision) && record.progressRevision >= 0) {
        rev = record.progressRevision;
      } else {
        valid = false;
      }
    }

    let seq = 0;
    if (record.progressSeq !== undefined && record.progressSeq !== null) {
      if (typeof record.progressSeq === "number" && Number.isFinite(record.progressSeq) && record.progressSeq >= 0) {
        seq = record.progressSeq;
      } else {
        valid = false;
      }
    }

    let sess = null;
    if (record.progressSessionId !== undefined && record.progressSessionId !== null && record.progressSessionId !== "") {
      if (typeof record.progressSessionId === "string") {
        sess = record.progressSessionId;
      } else {
        valid = false;
      }
    }

    let currentChapter = 0;
    if (record.currentChapter !== undefined && record.currentChapter !== null) {
      if (typeof record.currentChapter === "number" && Number.isFinite(record.currentChapter) && record.currentChapter >= 0) {
        currentChapter = record.currentChapter;
      } else {
        valid = false;
      }
    }

    let chapterScrollRatio = 0;
    if (record.chapterScrollRatio !== undefined && record.chapterScrollRatio !== null) {
      if (typeof record.chapterScrollRatio === "number" && Number.isFinite(record.chapterScrollRatio) && record.chapterScrollRatio >= 0) {
        chapterScrollRatio = Math.min(1, record.chapterScrollRatio);
      } else {
        valid = false;
      }
    }

    const bookInstanceId = typeof record.bookInstanceId === "string" && record.bookInstanceId.length > 0
      ? record.bookInstanceId
      : null;

    return {
      valid,
      rev,
      seq,
      sess,
      hasStartedReading: Boolean(record.hasStartedReading),
      currentChapter,
      chapterScrollRatio,
      bookInstanceId
    };
  }

  function registerBookDiskRevision(record, options = {}) {
    if (!record || !record.id) return;
    const norm = normalizeDiskProgressRecord(record);
    const force = Boolean(options.force);
    const prevKnown = knownDiskRevisionByBook.get(record.id);
    const prevState = knownDiskStateByBook.get(record.id);

    if (norm.valid) {
      const shouldUpdate = force ||
        prevKnown === undefined ||
        norm.rev > prevKnown ||
        (norm.rev === prevKnown && (!prevState || norm.sess !== prevState.sess || norm.seq > prevState.seq));
      if (shouldUpdate) {
        knownDiskRevisionByBook.set(record.id, norm.rev);
        knownDiskStateByBook.set(record.id, {
          rev: norm.rev,
          seq: norm.seq,
          sess: norm.sess
        });
      }
      const curSeq = bookSeqCounters.get(record.id) || 0;
      if (norm.seq > curSeq) {
        bookSeqCounters.set(record.id, norm.seq);
      }
    }

    if (norm.bookInstanceId) {
      bookInstanceIdByBook.set(record.id, norm.bookInstanceId);
    }
  }

  function registerLoadedBooksRevisions(records) {
    if (!Array.isArray(records)) return;
    for (let i = 0; i < records.length; i++) {
      if (records[i] && records[i].id) {
        registerBookDiskRevision(records[i], { force: true });
      }
    }
  }

  // ---- Espejo localStorage (propietario único: storage.js) ----
  function getLocalStorageSafe() {
    try {
      if (globalScope && globalScope.localStorage) {
        return globalScope.localStorage;
      }
    } catch (e) {}
    return null;
  }

  function getMirrorKey(bookId) {
    return `${MIRROR_PREFIX}${bookId}`;
  }

  function readProgressMirror(bookId) {
    if (!bookId) return null;
    const ls = getLocalStorageSafe();
    if (!ls) return null;
    try {
      const raw = ls.getItem(getMirrorKey(bookId));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function writeProgressMirror(bookId, payload) {
    if (!bookId || !payload || typeof payload !== "object") return false;
    const ls = getLocalStorageSafe();
    if (!ls) return false;
    try {
      ls.setItem(getMirrorKey(bookId), JSON.stringify(payload));
      return true;
    } catch (e) {
      return false;
    }
  }

  function removeProgressMirror(bookId) {
    if (!bookId) return false;
    const ls = getLocalStorageSafe();
    if (!ls) return false;
    try {
      ls.removeItem(getMirrorKey(bookId));
      return true;
    } catch (e) {
      return false;
    }
  }

  function listMirrorBookIds() {
    const ls = getLocalStorageSafe();
    if (!ls) return [];
    const ids = [];
    try {
      for (let i = 0; i < ls.length; i++) {
        const key = ls.key(i);
        if (typeof key === "string" && key.startsWith(MIRROR_PREFIX)) {
          const bookId = key.slice(MIRROR_PREFIX.length);
          if (bookId) ids.push(bookId);
        }
      }
    } catch (e) {}
    return ids;
  }

  function clearAllProgressMirrors() {
    const ids = listMirrorBookIds();
    for (let i = 0; i < ids.length; i++) {
      removeProgressMirror(ids[i]);
    }
  }

  function isValidMirrorStructure(mirror, expectedBookId) {
    if (!mirror || typeof mirror !== "object") return false;
    if (mirror.version !== 1) return false;
    if (typeof mirror.bookId !== "string" || !mirror.bookId || mirror.bookId !== expectedBookId) return false;
    if (typeof mirror.confirmedInIdb !== "boolean") return false;
    if (typeof mirror.progressSessionId !== "string" || !mirror.progressSessionId) return false;
    if (typeof mirror.progressSeq !== "number" || !Number.isFinite(mirror.progressSeq) || mirror.progressSeq <= 0) return false;
    if (typeof mirror.currentChapter !== "number" || !Number.isFinite(mirror.currentChapter) || mirror.currentChapter < 0) return false;
    if (typeof mirror.chapterScrollRatio !== "number" || !Number.isFinite(mirror.chapterScrollRatio) || mirror.chapterScrollRatio < 0 || mirror.chapterScrollRatio > 1) return false;
    if (typeof mirror.hasStartedReading !== "boolean") return false;
    if (typeof mirror.bookInstanceId !== "string" || !mirror.bookInstanceId) return false;
    if (mirror.chapterAnchor !== null && mirror.chapterAnchor !== undefined && typeof mirror.chapterAnchor !== "object") return false;

    if (mirror.confirmedInIdb) {
      if (typeof mirror.progressRevision !== "number" || !Number.isFinite(mirror.progressRevision) || mirror.progressRevision < 0) {
        return false;
      }
    } else {
      if (typeof mirror.baseRevisionKnown !== "boolean") return false;
      if (mirror.baseRevisionKnown) {
        if (typeof mirror.baseDiskRevision !== "number" || !Number.isFinite(mirror.baseDiskRevision) || mirror.baseDiskRevision < 0) {
          return false;
        }
        if (typeof mirror.baseDiskSeq !== "number" || !Number.isFinite(mirror.baseDiskSeq) || mirror.baseDiskSeq < 0) {
          return false;
        }
        if (!(mirror.baseDiskSessionId === null || (typeof mirror.baseDiskSessionId === "string" && mirror.baseDiskSessionId.length > 0))) {
          return false;
        }
      }
    }
    return true;
  }

  function buildConfirmedMirrorFromDiskRecord(record) {
    if (!record || !record.id) return null;
    const norm = normalizeDiskProgressRecord(record);
    if (!norm.valid || !norm.bookInstanceId) return null;
    if (!norm.hasStartedReading && norm.rev === 0 && norm.seq === 0 && norm.currentChapter === 0 && norm.chapterScrollRatio === 0) {
      return null;
    }
    if (!norm.sess || norm.seq <= 0) {
      return null;
    }
    return {
      version: 1,
      bookId: record.id,
      bookInstanceId: norm.bookInstanceId,
      confirmedInIdb: true,
      progressRevision: norm.rev,
      progressSessionId: norm.sess,
      progressSeq: norm.seq,
      baseRevisionKnown: true,
      baseDiskRevision: norm.rev,
      baseDiskSessionId: norm.sess,
      baseDiskSeq: norm.seq,
      currentChapter: norm.currentChapter,
      chapterScrollRatio: norm.chapterScrollRatio,
      chapterAnchor: record.chapterAnchor && typeof record.chapterAnchor === "object" ? record.chapterAnchor : null,
      hasStartedReading: norm.hasStartedReading
    };
  }

  function syncMirrorFromDiskRecord(record) {
    if (!record || !record.id) return false;
    const norm = normalizeDiskProgressRecord(record);
    if (!norm.valid || !norm.bookInstanceId) {
      removeProgressMirror(record.id);
      return false;
    }
    if (!norm.hasStartedReading && norm.rev === 0 && norm.seq === 0 && norm.currentChapter === 0 && norm.chapterScrollRatio === 0) {
      removeProgressMirror(record.id);
      return false;
    }
    const payload = buildConfirmedMirrorFromDiskRecord(record);
    if (!payload) {
      removeProgressMirror(record.id);
      return false;
    }
    return writeProgressMirror(record.id, payload);
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

  async function dbSaveStrictIdb(storeName, item) {
    let conn = await ensureDb();
    if (!conn) {
      putInMemoryStore(storeName, item);
      return { ok: true, persistedToIdb: false, persistedToMemory: true, error: null };
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
        tx.oncomplete = () => {
          putInMemoryStore(storeName, item);
          finish({ ok: true, persistedToIdb: true, persistedToMemory: false, retryableInvalidState: false, error: null });
        };
        tx.onerror = (ev) => {
          const err = tx.error || ev?.target?.error || null;
          if (isQuotaError(err)) notifyQuotaExceeded();
          const retryable = handleTransactionFailureAndMaybeReset(targetConn, err);
          finish({ ok: false, persistedToIdb: false, persistedToMemory: false, retryableInvalidState: retryable, error: err });
        };
        tx.onabort = () => {
          const err = tx.error || null;
          if (isQuotaError(err)) notifyQuotaExceeded();
          const retryable = handleTransactionFailureAndMaybeReset(targetConn, err);
          finish({ ok: false, persistedToIdb: false, persistedToMemory: false, retryableInvalidState: retryable, error: err });
        };
      } catch (e) {
        const retryable = handleTransactionFailureAndMaybeReset(targetConn, e);
        finish({ ok: false, persistedToIdb: false, persistedToMemory: false, retryableInvalidState: retryable, error: e });
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
    return {
      ok: Boolean(res.ok),
      persistedToIdb: Boolean(res.persistedToIdb),
      persistedToMemory: Boolean(res.persistedToMemory),
      error: res.error || null
    };
  }

  async function dbSave(storeName, item) {
    const res = await dbSaveStrictIdb(storeName, item);
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

  function cloneCleanupsMap(mapObj) {
    const out = {};
    if (!mapObj || typeof mapObj !== "object") return out;
    const entries = Object.entries(mapObj);
    for (let i = 0; i < entries.length; i++) {
      const bId = entries[i][0];
      const job = entries[i][1];
      if (!bId || !job || typeof job !== "object") continue;
      out[bId] = {
        bookId: job.bookId || bId,
        bookInstanceId: job.bookInstanceId || null,
        contentKeys: Array.isArray(job.contentKeys) ? job.contentKeys.slice() : [],
        assetKeys: Array.isArray(job.assetKeys) ? job.assetKeys.slice() : [],
        settingsKeys: Array.isArray(job.settingsKeys) ? job.settingsKeys.slice() : [],
        failedStores: Array.isArray(job.failedStores) ? job.failedStores.slice() : [],
        failedAt: typeof job.failedAt === "number" ? job.failedAt : Date.now()
      };
    }
    return out;
  }

  function hasPendingCleanupKeys(job) {
    if (!job || typeof job !== "object") return false;
    return (
      (Array.isArray(job.contentKeys) && job.contentKeys.length > 0) ||
      (Array.isArray(job.assetKeys) && job.assetKeys.length > 0) ||
      (Array.isArray(job.settingsKeys) && job.settingsKeys.length > 0)
    );
  }

  function pruneJobStoreDependencies(job, storeName, confirmedKeysSet = null) {
    if (!job || typeof job !== "object") return false;
    if (storeName === "bookContents") {
      if (confirmedKeysSet) {
        job.contentKeys = (job.contentKeys || []).filter(k => !confirmedKeysSet.has(k));
      } else {
        job.contentKeys = [];
      }
    } else if (storeName === "bookAssets") {
      if (confirmedKeysSet) {
        job.assetKeys = (job.assetKeys || []).filter(k => !confirmedKeysSet.has(k));
      } else {
        job.assetKeys = [];
      }
    } else if (storeName === "settings") {
      if (confirmedKeysSet) {
        job.settingsKeys = (job.settingsKeys || []).filter(k => !confirmedKeysSet.has(k));
      } else {
        job.settingsKeys = [];
      }
    }
    const remainingStores = [];
    if (Array.isArray(job.contentKeys) && job.contentKeys.length > 0) remainingStores.push("bookContents");
    if (Array.isArray(job.settingsKeys) && job.settingsKeys.length > 0) remainingStores.push("settings");
    if (Array.isArray(job.assetKeys) && job.assetKeys.length > 0) remainingStores.push("bookAssets");
    job.failedStores = remainingStores;
    return hasPendingCleanupKeys(job);
  }

  async function persistPendingAssetCleanupsMap(nextMap) {
    const clean = {};
    const entries = Object.entries(nextMap || {});
    for (let i = 0; i < entries.length; i++) {
      const id = entries[i][0];
      const job = entries[i][1];
      if (id && hasPendingCleanupKeys(job)) {
        clean[id] = job;
      }
    }
    pendingAssetCleanupsRam = clean;
    if (Object.keys(clean).length === 0) {
      const delRes = await dbDelete("settings", PENDING_CLEANUPS_KEY, { skipCleanupPrune: true });
      return {
        ok: Boolean(delRes.ok),
        persistedToIdb: Boolean(delRes.persistedToIdb),
        persistedToMemory: Boolean(delRes.persistedToMemory),
        error: delRes.error || null
      };
    }
    return await dbSaveStrictIdb("settings", { key: PENDING_CLEANUPS_KEY, val: clean });
  }

  async function prunePendingCleanupsAfterConfirmedStoreMutation(storeName, confirmedKeysSet = null) {
    if (storeName !== "bookContents" && storeName !== "bookAssets" && storeName !== "settings") return;
    let diskRec = null;
    try {
      diskRec = await dbGet("settings", PENDING_CLEANUPS_KEY);
    } catch (e) {}
    const diskMap = diskRec && diskRec.val && typeof diskRec.val === "object" ? diskRec.val : {};
    const merged = cloneCleanupsMap({ ...diskMap, ...pendingAssetCleanupsRam });
    const ids = Object.keys(merged);
    if (ids.length === 0) return;
    let changed = false;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const job = merged[id];
      const hadBefore = JSON.stringify(job);
      const stillNeeded = pruneJobStoreDependencies(job, storeName, confirmedKeysSet);
      if (!stillNeeded) {
        delete merged[id];
        changed = true;
      } else if (JSON.stringify(job) !== hadBefore) {
        changed = true;
      }
    }
    if (changed) {
      await persistPendingAssetCleanupsMap(merged);
    }
  }

  async function dbClear(storeName) {
    if (storeName === "books") {
      libraryClearEpoch++;
      bumpAllTrackedBookGenerations();
      const pendingQueues = Array.from(bookWriteQueues.values());
      if (pendingQueues.length > 0) {
        await Promise.allSettled(pendingQueues);
      }
    }

    let conn = await ensureDb();
    if (!conn) {
      inMemoryDb[storeName] = [];
      if (storeName === "books") {
        // Solo RAM temporal: limpiar estado de sesión RAM, pero NO borrar espejos localStorage
        // ni pendingAssetCleanups porque IndexedDB en disco no fue vaciado.
        knownDiskRevisionByBook.clear();
        knownDiskStateByBook.clear();
        bookInstanceIdByBook.clear();
        bookSeqCounters.clear();
        pendingRecoveryProgressPatches.clear();
        deletedBookIdsInSession.clear();
      } else if (storeName === "settings") {
        pendingAssetCleanupsRam = {};
      }
      return { ok: true, persistedToIdb: false, persistedToMemory: true, error: null };
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
        tx.objectStore(storeName).clear();
        tx.oncomplete = () => finish({ ok: true, persistedToIdb: true, persistedToMemory: false, retryableInvalidState: false, error: null });
        tx.onerror = (ev) => {
          const err = tx.error || ev?.target?.error || null;
          const retryable = handleTransactionFailureAndMaybeReset(targetConn, err);
          finish({ ok: false, persistedToIdb: false, persistedToMemory: false, retryableInvalidState: retryable, error: err });
        };
        tx.onabort = () => {
          const err = tx.error || null;
          const retryable = handleTransactionFailureAndMaybeReset(targetConn, err);
          finish({ ok: false, persistedToIdb: false, persistedToMemory: false, retryableInvalidState: retryable, error: err });
        };
      } catch (e) {
        const retryable = handleTransactionFailureAndMaybeReset(targetConn, e);
        finish({ ok: false, persistedToIdb: false, persistedToMemory: false, retryableInvalidState: retryable, error: e });
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

    if (res.ok && res.persistedToIdb) {
      inMemoryDb[storeName] = [];
      if (storeName === "books") {
        knownDiskRevisionByBook.clear();
        knownDiskStateByBook.clear();
        bookInstanceIdByBook.clear();
        bookSeqCounters.clear();
        pendingRecoveryProgressPatches.clear();
        deletedBookIdsInSession.clear();
        clearAllProgressMirrors();
        // NO eliminar pendingAssetCleanups aquí: los recursos asociados (bookContents/bookAssets/settings)
        // solo pueden considerarse limpios cuando sus propios stores confirmen vaciado en IDB.
      } else if (storeName === "bookContents" || storeName === "bookAssets") {
        await prunePendingCleanupsAfterConfirmedStoreMutation(storeName, null);
      } else if (storeName === "settings") {
        pendingAssetCleanupsRam = {};
      }
    }

    return {
      ok: Boolean(res.ok),
      persistedToIdb: Boolean(res.persistedToIdb),
      persistedToMemory: Boolean(res.persistedToMemory),
      error: res.error || null
    };
  }

  async function dbDelete(storeName, key, options = {}) {
    const keyProp = STORE_KEY_PATHS[storeName] || "key";
    let conn = await ensureDb();
    if (!conn) {
      if (inMemoryDb[storeName]) {
        inMemoryDb[storeName] = inMemoryDb[storeName].filter(x => x && x[keyProp] !== key);
      }
      return { ok: true, persistedToIdb: false, persistedToMemory: true, error: null };
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
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = () => finish({ ok: true, persistedToIdb: true, persistedToMemory: false, retryableInvalidState: false, error: null });
        tx.onerror = (ev) => {
          const err = tx.error || ev?.target?.error || null;
          const retryable = handleTransactionFailureAndMaybeReset(targetConn, err);
          finish({ ok: false, persistedToIdb: false, persistedToMemory: false, retryableInvalidState: retryable, error: err });
        };
        tx.onabort = () => {
          const err = tx.error || null;
          const retryable = handleTransactionFailureAndMaybeReset(targetConn, err);
          finish({ ok: false, persistedToIdb: false, persistedToMemory: false, retryableInvalidState: retryable, error: err });
        };
      } catch (e) {
        const retryable = handleTransactionFailureAndMaybeReset(targetConn, e);
        finish({ ok: false, persistedToIdb: false, persistedToMemory: false, retryableInvalidState: retryable, error: e });
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

    if (res.ok && res.persistedToIdb) {
      if (inMemoryDb[storeName]) {
        inMemoryDb[storeName] = inMemoryDb[storeName].filter(x => x && x[keyProp] !== key);
      }
      if (!options.skipCleanupPrune && (storeName === "bookContents" || storeName === "bookAssets" || storeName === "settings") && key !== PENDING_CLEANUPS_KEY) {
        await prunePendingCleanupsAfterConfirmedStoreMutation(storeName, new Set([key]));
      }
    }

    return {
      ok: Boolean(res.ok),
      persistedToIdb: Boolean(res.persistedToIdb),
      persistedToMemory: Boolean(res.persistedToMemory),
      error: res.error || null
    };
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

  async function dbDeleteBatch(storeName, keys, batchSize = 40, options = {}) {
    if (!Array.isArray(keys) || keys.length === 0) {
      return {
        ok: true,
        persistedToIdb: Boolean(db),
        persistedToMemory: false,
        deletedCount: 0,
        failedKeys: [],
        error: null
      };
    }

    const uniqueKeys = [];
    const seen = new Set();
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k !== undefined && k !== null && !seen.has(k)) {
        seen.add(k);
        uniqueKeys.push(k);
      }
    }
    if (uniqueKeys.length === 0) {
      return {
        ok: true,
        persistedToIdb: Boolean(db),
        persistedToMemory: false,
        deletedCount: 0,
        failedKeys: [],
        error: null
      };
    }

    const keyProp = STORE_KEY_PATHS[storeName] || "key";
    let conn = await ensureDb();
    if (!conn) {
      if (inMemoryDb[storeName]) {
        const delSet = new Set(uniqueKeys);
        inMemoryDb[storeName] = inMemoryDb[storeName].filter(x => x && !delSet.has(x[keyProp]));
      }
      return {
        ok: true,
        persistedToIdb: false,
        persistedToMemory: true,
        deletedCount: uniqueKeys.length,
        failedKeys: [],
        error: null
      };
    }

    const runChunk = (targetConn, chunk) => new Promise((resolve) => {
      let settled = false;
      const finish = (res) => {
        if (settled) return;
        settled = true;
        resolve(res);
      };
      try {
        const tx = targetConn.transaction(storeName, "readwrite");
        const store = tx.objectStore(storeName);
        for (let j = 0; j < chunk.length; j++) {
          store.delete(chunk[j]);
        }
        tx.oncomplete = () => finish({ ok: true, retryableInvalidState: false, error: null });
        tx.onerror = (ev) => {
          const err = tx.error || ev?.target?.error || null;
          const retryable = handleTransactionFailureAndMaybeReset(targetConn, err);
          finish({ ok: false, retryableInvalidState: retryable, error: err });
        };
        tx.onabort = () => {
          const err = tx.error || null;
          const retryable = handleTransactionFailureAndMaybeReset(targetConn, err);
          finish({ ok: false, retryableInvalidState: retryable, error: err });
        };
      } catch (e) {
        const retryable = handleTransactionFailureAndMaybeReset(targetConn, e);
        finish({ ok: false, retryableInvalidState: retryable, error: e });
      }
    });

    let deletedCount = 0;
    const confirmedKeys = [];
    const failedKeys = [];
    let firstError = null;
    const step = Math.max(1, batchSize || 40);

    for (let i = 0; i < uniqueKeys.length; i += step) {
      const chunk = uniqueKeys.slice(i, i + step);
      let activeConn = conn || await ensureDb();
      if (!activeConn) {
        if (!firstError) firstError = new Error("IndexedDB connection lost during batch delete");
        for (let k = 0; k < chunk.length; k++) failedKeys.push(chunk[k]);
        continue;
      }

      let chunkRes = await runChunk(activeConn, chunk);
      if (!chunkRes.ok && chunkRes.retryableInvalidState) {
        resetRetryCooldown();
        activeConn = await ensureDb();
        conn = activeConn;
        if (activeConn) {
          chunkRes = await runChunk(activeConn, chunk);
        }
      }

      if (chunkRes.ok) {
        if (inMemoryDb[storeName]) {
          const chunkSet = new Set(chunk);
          inMemoryDb[storeName] = inMemoryDb[storeName].filter(x => x && !chunkSet.has(x[keyProp]));
        }
        deletedCount += chunk.length;
        for (let k = 0; k < chunk.length; k++) confirmedKeys.push(chunk[k]);
      } else {
        if (!firstError && chunkRes.error) firstError = chunkRes.error;
        for (let k = 0; k < chunk.length; k++) failedKeys.push(chunk[k]);
      }
    }

    if (!options.skipCleanupPrune && confirmedKeys.length > 0 && (storeName === "bookContents" || storeName === "bookAssets" || storeName === "settings")) {
      const confirmedSet = new Set(confirmedKeys.filter(k => k !== PENDING_CLEANUPS_KEY));
      if (confirmedSet.size > 0) {
        await prunePendingCleanupsAfterConfirmedStoreMutation(storeName, confirmedSet);
      }
    }

    if (failedKeys.length === 0) {
      return {
        ok: true,
        persistedToIdb: true,
        persistedToMemory: false,
        deletedCount,
        failedKeys: [],
        error: null
      };
    }

    return {
      ok: false,
      persistedToIdb: false,
      persistedToMemory: false,
      deletedCount,
      failedKeys,
      error: firstError || new Error("Partial or failed batch delete in IndexedDB")
    };
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
    if (typeof book.bookInstanceId === "string" && book.bookInstanceId) {
      metaRecord.bookInstanceId = book.bookInstanceId;
    }
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
    registerBookDiskRevision(record, { force: Boolean(options.forceSyncProgress) });

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

    const capturedGen = options.capturedGen !== undefined ? options.capturedGen : getBookGeneration(bookId);
    const capturedClearEpoch = options.capturedClearEpoch !== undefined ? options.capturedClearEpoch : libraryClearEpoch;
    const isStaleGeneration = () => (
      capturedClearEpoch !== libraryClearEpoch ||
      capturedGen !== getBookGeneration(bookId)
    );

    return enqueueBookWrite(bookId, async () => {
      if (isStaleGeneration()) {
        return {
          ok: true,
          persistedToIdb: false,
          persistedToMemory: false,
          writtenToIdb: false,
          skipped: true,
          reason: "stale-instance-generation",
          record: null
        };
      }
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
        if (isStaleGeneration()) {
          return {
            ok: true,
            persistedToIdb: false,
            persistedToMemory: false,
            writtenToIdb: false,
            skipped: true,
            reason: "stale-instance-generation",
            record: null
          };
        }
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
            if (isStaleGeneration()) {
              didPut = false;
              skipReason = "stale-instance-generation";
              finalRecord = null;
              return;
            }
            if (deletedBookIdsInSession.has(bookId) && !options.allowCreate) {
              didPut = false;
              skipReason = "deleted-in-session";
              finalRecord = null;
              return;
            }

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
            if (finalRecord && !isStaleGeneration() && !(deletedBookIdsInSession.has(bookId) && !options.allowCreate)) {
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
      if (!res.ok && res.retryableInvalidState && !isStaleGeneration()) {
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
   * Evalúa si un espejo pendiente es reconciliable de forma determinista contra un registro de disco.
   */
  function canAcceptPendingMirrorAgainstDisk(mirror, diskRecord) {
    if (!diskRecord || !diskRecord.id) return { accept: false, reason: "missing-book" };
    const norm = normalizeDiskProgressRecord(diskRecord);
    if (!norm.valid) return { accept: false, reason: "invalid-disk-metadata" };
    if (!norm.bookInstanceId || !mirror.bookInstanceId || norm.bookInstanceId !== mirror.bookInstanceId) {
      return { accept: false, reason: "instance-id-mismatch" };
    }

    if (!mirror.baseRevisionKnown) {
      if (
        norm.rev > 0 ||
        norm.sess !== null ||
        norm.seq > 0 ||
        norm.hasStartedReading ||
        norm.currentChapter > 0 ||
        norm.chapterScrollRatio > 0
      ) {
        return { accept: false, reason: "unverified-mirror-disk-not-virgin" };
      }
      return { accept: true, reason: null, norm };
    }

    if (
      typeof mirror.baseDiskRevision !== "number" ||
      !Number.isFinite(mirror.baseDiskRevision) ||
      typeof mirror.baseDiskSeq !== "number" ||
      !Number.isFinite(mirror.baseDiskSeq) ||
      !(mirror.baseDiskSessionId === null || (typeof mirror.baseDiskSessionId === "string" && mirror.baseDiskSessionId.length > 0))
    ) {
      return { accept: false, reason: "invalid-mirror-base-metadata" };
    }

    if (norm.rev !== mirror.baseDiskRevision) {
      return { accept: false, reason: "revision-mismatch" };
    }

    const matchesExactBase = (
      norm.sess === mirror.baseDiskSessionId &&
      norm.seq === mirror.baseDiskSeq
    );
    const matchesSameSessionAdvance = (
      norm.sess === mirror.progressSessionId &&
      norm.seq >= mirror.baseDiskSeq &&
      norm.seq < mirror.progressSeq
    );

    if (matchesExactBase || matchesSameSessionAdvance) {
      return { accept: true, reason: null, norm };
    }
    return { accept: false, reason: "cross-session-or-seq-conflict" };
  }

  /**
   * Actualización de progreso de lectura con guarda optimista multi-pestaña (progressRevision),
   * conservación de parches pendientes en pendingRecoveryProgressPatches si IDB no está disponible,
   * y escritura síncrona previa del espejo en localStorage desde este único propietario.
   */
  async function saveBookProgressPatch(bookId, progressPatch, options = {}) {
    if (!bookId || !progressPatch || typeof progressPatch !== "object") {
      return { ok: false, persistedToIdb: false, persistedToMemory: false, writtenToIdb: false, skipped: false };
    }

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

    const capturedGen = getBookGeneration(bookId);
    const capturedClearEpoch = libraryClearEpoch;
    const isRecoveryDrain = Boolean(options.isRecoveryDrain);
    const fromMirrorReconcile = Boolean(options.fromMirrorReconcile);

    const knownState = knownDiskStateByBook.get(bookId) || null;
    const baseRevisionKnown = options.baseRevisionKnown !== undefined
      ? Boolean(options.baseRevisionKnown)
      : Boolean(knownState && knownDiskRevisionByBook.has(bookId));
    const expectedBaseRevision = baseRevisionKnown
      ? (options.expectedBaseRevision !== undefined ? options.expectedBaseRevision : (knownState ? knownState.rev : knownDiskRevisionByBook.get(bookId)))
      : null;
    const expectedBaseSessionId = baseRevisionKnown
      ? (options.expectedBaseSessionId !== undefined ? options.expectedBaseSessionId : (knownState ? knownState.sess : null))
      : undefined;
    const expectedBaseSeq = baseRevisionKnown
      ? (options.expectedBaseSeq !== undefined ? options.expectedBaseSeq : (knownState ? knownState.seq : 0))
      : undefined;

    const incomingSeq = typeof progressPatch.progressSeq === "number" && Number.isFinite(progressPatch.progressSeq)
      ? progressPatch.progressSeq
      : nextBookProgressSeq(bookId);
    const incomingTs = typeof progressPatch.progressUpdatedAt === "number" && Number.isFinite(progressPatch.progressUpdatedAt)
      ? progressPatch.progressUpdatedAt
      : nextMonotonicProgressTimestamp();
    const incomingSessionId = (typeof progressPatch.progressSessionId === "string" && progressPatch.progressSessionId)
      ? progressPatch.progressSessionId
      : STORAGE_SESSION_ID;

    const resolvedInstanceId = (
      (typeof options.expectedBookInstanceId === "string" && options.expectedBookInstanceId) ||
      bookInstanceIdByBook.get(bookId) ||
      (options.fallbackBook && typeof options.fallbackBook.bookInstanceId === "string" && options.fallbackBook.bookInstanceId) ||
      null
    );

    const preparedPatch = {
      currentChapter: typeof progressPatch.currentChapter === "number" && Number.isFinite(progressPatch.currentChapter)
        ? Math.max(0, progressPatch.currentChapter)
        : undefined,
      chapterScrollRatio: typeof progressPatch.chapterScrollRatio === "number" && Number.isFinite(progressPatch.chapterScrollRatio)
        ? Math.max(0, Math.min(1, progressPatch.chapterScrollRatio))
        : undefined,
      chapterAnchor: progressPatch.chapterAnchor !== undefined ? progressPatch.chapterAnchor : undefined,
      hasStartedReading: progressPatch.hasStartedReading !== undefined ? Boolean(progressPatch.hasStartedReading) : undefined,
      lastOpenedAt: typeof progressPatch.lastOpenedAt === "number" ? progressPatch.lastOpenedAt : undefined,
      progressSeq: incomingSeq,
      progressSessionId: incomingSessionId,
      progressUpdatedAt: incomingTs,
      expectedBaseRevision,
      expectedBaseSessionId,
      expectedBaseSeq,
      expectedBookInstanceId: resolvedInstanceId,
      baseRevisionKnown,
      explicitUserChapterSwitch: Boolean(options.explicitUserChapterSwitch)
    };

    // Escritura síncrona previa del espejo pendiente antes de cualquier await (para pagehide / freeze / beforeunload)
    if (!options.skipPreMirrorWrite && !isRecoveryDrain && !fromMirrorReconcile) {
      const refBook = options.fallbackBook || hooks.getCurrentBook() || null;
      const existingMirror = readProgressMirror(bookId);
      const mirrorChapter = preparedPatch.currentChapter !== undefined
        ? preparedPatch.currentChapter
        : (refBook && refBook.id === bookId && typeof refBook.currentChapter === "number" && Number.isFinite(refBook.currentChapter)
          ? Math.max(0, refBook.currentChapter)
          : (existingMirror && typeof existingMirror.currentChapter === "number" && Number.isFinite(existingMirror.currentChapter) ? existingMirror.currentChapter : 0));
      const mirrorRatio = preparedPatch.chapterScrollRatio !== undefined
        ? preparedPatch.chapterScrollRatio
        : (refBook && refBook.id === bookId && typeof refBook.chapterScrollRatio === "number" && Number.isFinite(refBook.chapterScrollRatio)
          ? Math.max(0, Math.min(1, refBook.chapterScrollRatio))
          : (existingMirror && typeof existingMirror.chapterScrollRatio === "number" && Number.isFinite(existingMirror.chapterScrollRatio) ? existingMirror.chapterScrollRatio : 0));
      const mirrorAnchor = preparedPatch.chapterAnchor !== undefined
        ? preparedPatch.chapterAnchor
        : (refBook && refBook.id === bookId ? (refBook.chapterAnchor || null) : (existingMirror ? existingMirror.chapterAnchor || null : null));
      const mirrorStarted = preparedPatch.hasStartedReading !== undefined
        ? preparedPatch.hasStartedReading
        : Boolean((refBook && refBook.id === bookId && refBook.hasStartedReading) || mirrorChapter > 0 || mirrorRatio > 0);

      if (mirrorStarted || mirrorChapter > 0 || mirrorRatio > 0) {
        const preMirrorPayload = {
          version: 1,
          bookId,
          bookInstanceId: resolvedInstanceId,
          confirmedInIdb: false,
          progressRevision: null,
          progressSessionId: preparedPatch.progressSessionId,
          progressSeq: preparedPatch.progressSeq,
          baseRevisionKnown: preparedPatch.baseRevisionKnown,
          baseDiskRevision: preparedPatch.baseRevisionKnown ? preparedPatch.expectedBaseRevision : null,
          baseDiskSessionId: preparedPatch.baseRevisionKnown ? preparedPatch.expectedBaseSessionId : undefined,
          baseDiskSeq: preparedPatch.baseRevisionKnown ? preparedPatch.expectedBaseSeq : null,
          currentChapter: mirrorChapter,
          chapterScrollRatio: mirrorRatio,
          chapterAnchor: mirrorAnchor && typeof mirrorAnchor === "object" ? mirrorAnchor : null,
          hasStartedReading: mirrorStarted
        };
        writeProgressMirror(bookId, preMirrorPayload);
      }
    }

    const res = await dbUpdateBookInTransaction(
      bookId,
      (diskRecord) => {
        if (!diskRecord) {
          if (isRecoveryDrain || fromMirrorReconcile || !options.fallbackBook) {
            return {
              skip: true,
              reason: fromMirrorReconcile
                ? "mirror-reconcile-missing-book"
                : (isRecoveryDrain ? "recovery-missing-book" : "missing-book")
            };
          }
        }

        const base = diskRecord ? { ...diskRecord } : buildMetaRecord(options.fallbackBook);
        const norm = normalizeDiskProgressRecord(base);
        const diskRev = norm.rev;
        const diskSeq = norm.seq;
        const diskSess = norm.sess;

        if (fromMirrorReconcile) {
          const check = canAcceptPendingMirrorAgainstDisk(options.mirrorDescriptor, base);
          if (!check.accept) {
            return { skip: true, reason: check.reason || "mirror-reconcile-rejected", record: base };
          }
        } else if (isRecoveryDrain) {
          if (!preparedPatch.baseRevisionKnown) {
            const hasDiskProgress = Boolean(
              !norm.valid ||
              norm.hasStartedReading ||
              norm.currentChapter > 0 ||
              norm.chapterScrollRatio > 0 ||
              diskRev > 0 ||
              diskSess !== null ||
              diskSeq > 0
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

        if (!base.bookInstanceId) {
          base.bookInstanceId = preparedPatch.expectedBookInstanceId || generateBookInstanceId();
        }

        const nextRev = Math.max(diskRev, preparedPatch.expectedBaseRevision || 0) + 1;
        base.progressRevision = nextRev;
        base.progressSeq = preparedPatch.progressSeq;
        base.progressSessionId = preparedPatch.progressSessionId;
        base.progressUpdatedAt = preparedPatch.progressUpdatedAt;

        return { skip: false, record: base };
      },
      {
        allowCreate: Boolean(options.fallbackBook && !isRecoveryDrain && !fromMirrorReconcile),
        forceSyncProgress: true,
        isProgressWrite: true,
        capturedGen,
        capturedClearEpoch
      }
    );

    const stillSameInstance = (
      capturedClearEpoch === libraryClearEpoch &&
      capturedGen === getBookGeneration(bookId) &&
      !(deletedBookIdsInSession.has(bookId) && !options.allowCreate)
    );

    if (stillSameInstance) {
      if (res.persistedToIdb && res.record) {
        const curMirror = readProgressMirror(bookId);
        const hasNewerPendingInSameSession = Boolean(
          curMirror &&
          !curMirror.confirmedInIdb &&
          curMirror.progressSessionId === STORAGE_SESSION_ID &&
          typeof curMirror.progressSeq === "number" &&
          curMirror.progressSeq > preparedPatch.progressSeq &&
          (!res.record.bookInstanceId || !curMirror.bookInstanceId || curMirror.bookInstanceId === res.record.bookInstanceId)
        );
        if (!hasNewerPendingInSameSession) {
          syncMirrorFromDiskRecord(res.record);
        }
      } else if (
        res.skipped &&
        (
          res.reason === "external-revision-conflict" ||
          res.reason === "recovery-disk-has-progress" ||
          res.reason === "mirror-reconcile-rejected" ||
          res.reason === "instance-id-mismatch" ||
          res.reason === "revision-mismatch" ||
          res.reason === "cross-session-or-seq-conflict" ||
          res.reason === "unverified-mirror-disk-not-virgin" ||
          res.reason === "invalid-disk-metadata" ||
          res.reason === "invalid-mirror-base-metadata"
        )
      ) {
        if (res.record) {
          syncBookCachesAfterCommit(res.record, { forceSyncProgress: true });
          syncMirrorFromDiskRecord(res.record);
        }
        if (res.reason === "external-revision-conflict" && res.record && typeof hooks.onExternalProgressConflict === "function") {
          try {
            hooks.onExternalProgressConflict({
              bookId,
              diskRecord: res.record,
              attemptedPatch: preparedPatch
            });
          } catch (e) {}
        }
      } else if (res.skipped && res.reason === "mirror-reconcile-missing-book") {
        removeProgressMirror(bookId);
      }
    }

    // Si falló IDB o cayó a RAM temporal (y no es ya un drenado conflictivo/descartado), conservar en pendingRecoveryProgressPatches
    if (!res.persistedToIdb && !res.skipped && !isRecoveryDrain && !fromMirrorReconcile && stillSameInstance) {
      const existingPending = pendingRecoveryProgressPatches.get(bookId);
      if (!existingPending || preparedPatch.progressSeq >= existingPending.progressSeq) {
        pendingRecoveryProgressPatches.set(bookId, preparedPatch);
      }
    } else if (res.persistedToIdb && isRecoveryDrain) {
      pendingRecoveryProgressPatches.delete(bookId);
    } else if (res.skipped && isRecoveryDrain) {
      pendingRecoveryProgressPatches.delete(bookId);
    } else if (res.persistedToIdb && !isRecoveryDrain && !fromMirrorReconcile) {
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
      if (!patch || deletedBookIdsInSession.has(bookId)) {
        pendingRecoveryProgressPatches.delete(bookId);
        continue;
      }
      const res = await saveBookProgressPatch(bookId, patch, {
        isRecoveryDrain: true,
        baseRevisionKnown: patch.baseRevisionKnown,
        expectedBaseRevision: patch.expectedBaseRevision,
        expectedBaseSessionId: patch.expectedBaseSessionId,
        expectedBaseSeq: patch.expectedBaseSeq,
        expectedBookInstanceId: patch.expectedBookInstanceId
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
    const capturedGen = getBookGeneration(book.id);
    const capturedClearEpoch = libraryClearEpoch;

    const res = await dbUpdateBookInTransaction(
      book.id,
      (diskRecord) => {
        if (!diskRecord) {
          fullRec.bookInstanceId = fullRec.bookInstanceId || generateBookInstanceId();
          fullRec.progressRevision = 1;
          fullRec.progressSeq = seq;
          fullRec.progressSessionId = STORAGE_SESSION_ID;
          fullRec.progressUpdatedAt = ts;
          return { skip: false, record: fullRec };
        }

        const diskRev = typeof diskRecord.progressRevision === "number" && Number.isFinite(diskRecord.progressRevision)
          ? diskRecord.progressRevision
          : 0;
        const merged = { ...diskRecord, ...fullRec };
        if (options.kind === "full") {
          merged.bookInstanceId = fullRec.bookInstanceId || generateBookInstanceId();
        } else {
          merged.bookInstanceId = diskRecord.bookInstanceId || fullRec.bookInstanceId || generateBookInstanceId();
        }
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
        preserveNewerInMemoryProgress: !allowProgressOverwrite,
        capturedGen,
        capturedClearEpoch
      }
    );

    if (res.persistedToIdb && res.record) {
      syncMirrorFromDiskRecord(res.record);
    }
    return Boolean(res.ok);
  }

  async function saveFullBookToDb(bookData, assetBlobs = []) {
    if (!bookData || !bookData.id) return false;
    const bookId = bookData.id;

    // Barrera determinista para reimportaciones sobre el mismo bookId
    const priorQueue = bookWriteQueues.get(bookId);
    deletedBookIdsInSession.add(bookId);
    bumpBookGeneration(bookId);
    if (priorQueue) {
      await priorQueue.catch(() => {});
    }

    // Si había una limpieza pendiente para este mismo bookId, ejecutarla/purgarla antes de escribir los nuevos recursos
    await flushPendingAssetCleanupsForBookId(bookId);

    pendingRecoveryProgressPatches.delete(bookId);
    knownDiskRevisionByBook.delete(bookId);
    knownDiskStateByBook.delete(bookId);
    bookSeqCounters.delete(bookId);
    bookInstanceIdByBook.delete(bookId);
    removeProgressMirror(bookId);

    // Toda importación completa crea una nueva identidad de instancia aunque reutilice bookId (p. ej. backup)
    bookData.bookInstanceId = generateBookInstanceId();

    const removeFromBooksList = (targetBookId) => {
      const list = hooks.getBooksList();
      if (Array.isArray(list)) {
        hooks.setBooksList(list.filter(b => b && b.id !== targetBookId));
      }
    };

    if (Array.isArray(assetBlobs) && assetBlobs.length > 0) {
      const assetBatch = [];
      for (let i = 0; i < assetBlobs.length; i++) {
        const asset = assetBlobs[i];
        if (!asset || !asset.assetKey) continue;
        assetBatch.push({
          assetKey: asset.assetKey,
          bookId,
          buffer: asset.buffer || null,
          mimeType: asset.mimeType || "image/jpeg"
        });
        assetBlobs[i] = null;
      }
      if (assetBatch.length > 0) {
        const assetsSaved = await dbSaveBatch("bookAssets", assetBatch, 16);
        if (!assetsSaved) {
          await deleteBookAndAssets(bookId).catch(() => {});
          removeFromBooksList(bookId);
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
          bookId: `${bookId}__chunk_${c}`,
          chapters: slice
        });
      }
      contentBatch.push({
        bookId,
        chunkCount,
        chapters: [],
        footnotes: bookData.footnotes || {}
      });
      contentSaved = await dbSaveBatch("bookContents", contentBatch, 10);
    } else {
      contentSaved = await dbSave("bookContents", {
        bookId,
        chunkCount: 0,
        chapters,
        footnotes: bookData.footnotes || {}
      });
    }

    if (!contentSaved) {
      await deleteBookAndAssets(bookId).catch(() => {});
      removeFromBooksList(bookId);
      return false;
    }

    deletedBookIdsInSession.delete(bookId);
    const metaSaved = await saveBookMeta(bookData, { allowProgressOverwrite: true, kind: "full" });
    if (!metaSaved) {
      await deleteBookAndAssets(bookId).catch(() => {});
      removeFromBooksList(bookId);
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

  async function loadMergedPendingAssetCleanups() {
    let diskRec = null;
    if (db) {
      try {
        diskRec = await dbGet("settings", PENDING_CLEANUPS_KEY);
      } catch (e) {}
    }
    const diskMap = diskRec && diskRec.val && typeof diskRec.val === "object" ? diskRec.val : {};
    const merged = cloneCleanupsMap({ ...diskMap, ...pendingAssetCleanupsRam });
    pendingAssetCleanupsRam = merged;
    return merged;
  }

  async function executeSingleCleanupJob(job) {
    if (!job || !job.bookId) return { done: true, failedStores: [] };
    const failedStores = [];

    if (Array.isArray(job.contentKeys) && job.contentKeys.length > 0) {
      const cRes = await dbDeleteBatch("bookContents", job.contentKeys, 40, { skipCleanupPrune: true });
      if (cRes.persistedToIdb) {
        job.contentKeys = [];
      } else {
        if (Array.isArray(cRes.failedKeys) && cRes.failedKeys.length > 0) {
          job.contentKeys = cRes.failedKeys;
        }
        failedStores.push("bookContents");
      }
    }

    if (Array.isArray(job.settingsKeys) && job.settingsKeys.length > 0) {
      const sRes = await dbDeleteBatch("settings", job.settingsKeys, 40, { skipCleanupPrune: true });
      if (sRes.persistedToIdb) {
        job.settingsKeys = [];
      } else {
        if (Array.isArray(sRes.failedKeys) && sRes.failedKeys.length > 0) {
          job.settingsKeys = sRes.failedKeys;
        }
        failedStores.push("settings");
      }
    }

    if (Array.isArray(job.assetKeys) && job.assetKeys.length > 0) {
      const aRes = await dbDeleteBatch("bookAssets", job.assetKeys, 40, { skipCleanupPrune: true });
      if (aRes.persistedToIdb) {
        job.assetKeys = [];
      } else {
        if (Array.isArray(aRes.failedKeys) && aRes.failedKeys.length > 0) {
          job.assetKeys = aRes.failedKeys;
        }
        failedStores.push("bookAssets");
      }
    }

    job.failedStores = failedStores;
    return { done: !hasPendingCleanupKeys(job), failedStores };
  }

  async function flushPendingAssetCleanups(loadedBooks = null) {
    if (!db) return { processed: 0, remaining: Object.keys(pendingAssetCleanupsRam).length };
    const merged = await loadMergedPendingAssetCleanups();
    const ids = Object.keys(merged);
    if (ids.length === 0) return { processed: 0, remaining: 0 };

    const books = Array.isArray(loadedBooks) ? loadedBooks : await dbGetAll("books");
    const liveIds = new Set((books || []).filter(b => b && b.id).map(b => b.id));
    let processed = 0;

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const job = merged[id];
      if (!job || liveIds.has(id)) {
        // Nunca borrar recursos de un bookId vivo actualmente en IndexedDB "books"
        delete merged[id];
        continue;
      }
      processed++;
      const res = await executeSingleCleanupJob(job);
      if (res.done) {
        delete merged[id];
      }
    }

    await persistPendingAssetCleanupsMap(merged);
    return { processed, remaining: Object.keys(merged).length };
  }

  async function flushPendingAssetCleanupsForBookId(bookId) {
    if (!bookId) return;
    const merged = await loadMergedPendingAssetCleanups();
    const job = merged[bookId];
    if (!job) return;
    if (db) {
      await executeSingleCleanupJob(job);
    }
    delete merged[bookId];
    await persistPendingAssetCleanupsMap(merged);
  }

  async function backfillMissingInstanceIds(booksListInput = null) {
    const books = Array.isArray(booksListInput) ? booksListInput : await dbGetAll("books");
    if (!Array.isArray(books) || books.length === 0) return [];
    const updated = [];
    for (let i = 0; i < books.length; i++) {
      const b = books[i];
      if (!b || !b.id) continue;
      if (typeof b.bookInstanceId === "string" && b.bookInstanceId.length > 0) {
        bookInstanceIdByBook.set(b.id, b.bookInstanceId);
        continue;
      }
      const assignedId = generateBookInstanceId();
      const res = await dbUpdateBookInTransaction(
        b.id,
        (diskRecord) => {
          if (!diskRecord) return { skip: true, reason: "missing-book" };
          if (typeof diskRecord.bookInstanceId === "string" && diskRecord.bookInstanceId.length > 0) {
            return { skip: true, reason: "already-has-instance-id", record: diskRecord };
          }
          // Asignar únicamente bookInstanceId preservando exactamente progreso, revisión, sesión y secuencia
          const patched = { ...diskRecord, bookInstanceId: assignedId };
          return { skip: false, record: patched };
        },
        {
          allowCreate: false,
          forceSyncProgress: false,
          preserveNewerInMemoryProgress: true
        }
      );
      if ((res.persistedToIdb || res.skipped) && res.record && res.record.bookInstanceId) {
        b.bookInstanceId = res.record.bookInstanceId;
        bookInstanceIdByBook.set(b.id, res.record.bookInstanceId);
        if (res.persistedToIdb) {
          syncMirrorFromDiskRecord(res.record);
        }
        updated.push({ bookId: b.id, bookInstanceId: res.record.bookInstanceId, persistedToIdb: res.persistedToIdb });
      }
    }
    return updated;
  }

  async function reconcileProgressMirrors(booksListInput = null) {
    const mirrorIds = listMirrorBookIds();
    if (mirrorIds.length === 0) return [];
    const books = Array.isArray(booksListInput) ? booksListInput : await dbGetAll("books");
    const booksMap = new Map();
    if (Array.isArray(books)) {
      for (let i = 0; i < books.length; i++) {
        if (books[i] && books[i].id) booksMap.set(books[i].id, books[i]);
      }
    }

    const results = [];
    for (let i = 0; i < mirrorIds.length; i++) {
      const bookId = mirrorIds[i];
      const diskRecord = booksMap.get(bookId) || null;
      if (!diskRecord || deletedBookIdsInSession.has(bookId)) {
        removeProgressMirror(bookId);
        results.push({ bookId, action: "removed-missing-book", applied: false });
        continue;
      }

      const mirror = readProgressMirror(bookId);
      if (!isValidMirrorStructure(mirror, bookId)) {
        syncMirrorFromDiskRecord(diskRecord);
        results.push({ bookId, action: "rejected-invalid-mirror", applied: false });
        continue;
      }

      const norm = normalizeDiskProgressRecord(diskRecord);
      if (!norm.valid || !norm.bookInstanceId || mirror.bookInstanceId !== norm.bookInstanceId) {
        // Regla estricta Punto 1: sin igualdad estricta no vacía de bookInstanceId, jamás restaurar espejo
        syncMirrorFromDiskRecord(diskRecord);
        results.push({ bookId, action: "rejected-instance-mismatch", applied: false });
        continue;
      }

      if (mirror.confirmedInIdb) {
        // Espejo confirmado jamás se promueve a IndexedDB; cualquier discrepancia se corrige desde disco
        const matchesDisk = (
          mirror.progressRevision === norm.rev &&
          mirror.progressSessionId === norm.sess &&
          mirror.progressSeq === norm.seq
        );
        if (!matchesDisk) {
          syncMirrorFromDiskRecord(diskRecord);
          results.push({ bookId, action: "refreshed-confirmed-mismatch", applied: false });
        } else {
          results.push({ bookId, action: "confirmed-in-sync", applied: false });
        }
        continue;
      }

      // Espejo pendiente (confirmedInIdb === false)
      const check = canAcceptPendingMirrorAgainstDisk(mirror, diskRecord);
      if (!check.accept) {
        syncMirrorFromDiskRecord(diskRecord);
        results.push({ bookId, action: `rejected-${check.reason || "conflict"}`, applied: false });
        continue;
      }

      const nextSeq = nextBookProgressSeq(bookId, Math.max(norm.seq, mirror.progressSeq));
      const patchRes = await saveBookProgressPatch(
        bookId,
        {
          currentChapter: mirror.currentChapter,
          chapterScrollRatio: mirror.chapterScrollRatio,
          chapterAnchor: mirror.chapterAnchor,
          hasStartedReading: mirror.hasStartedReading,
          progressSeq: nextSeq,
          progressSessionId: STORAGE_SESSION_ID
        },
        {
          fromMirrorReconcile: true,
          mirrorDescriptor: mirror,
          baseRevisionKnown: mirror.baseRevisionKnown,
          expectedBaseRevision: mirror.baseRevisionKnown ? mirror.baseDiskRevision : null,
          expectedBaseSessionId: mirror.baseRevisionKnown ? mirror.baseDiskSessionId : undefined,
          expectedBaseSeq: mirror.baseRevisionKnown ? mirror.baseDiskSeq : undefined,
          expectedBookInstanceId: norm.bookInstanceId
        }
      );

      if (patchRes.persistedToIdb && patchRes.record) {
        booksMap.set(bookId, patchRes.record);
        results.push({ bookId, action: "reconciled-to-idb", applied: true, record: patchRes.record });
      } else {
        results.push({
          bookId,
          action: patchRes.skipped ? `rejected-${patchRes.reason || "tx-skip"}` : "deferred-reconcile",
          applied: false
        });
      }
    }

    return results;
  }

  async function deleteBookAndAssets(bookId) {
    if (!bookId) {
      return {
        ok: false,
        persistedToIdb: false,
        persistedToMemory: false,
        deletedBook: false,
        deletedFromIdb: false,
        deletedFromMemoryOnly: false,
        partial: false,
        pendingCleanupPersisted: false,
        orphanedAssetsPossible: false,
        failedStores: [],
        error: new Error("Invalid bookId")
      };
    }

    bumpBookGeneration(bookId);
    deletedBookIdsInSession.add(bookId);
    const tail = bookWriteQueues.get(bookId);
    if (tail) {
      await tail.catch(() => {});
    }

    const existingBookRec = await dbGet("books", bookId).catch(() => null);
    const capturedInstanceId = (
      (existingBookRec && typeof existingBookRec.bookInstanceId === "string" && existingBookRec.bookInstanceId) ||
      bookInstanceIdByBook.get(bookId) ||
      null
    );

    const contentRec = await dbGet("bookContents", bookId);
    const contentKeysToDelete = [bookId];
    if (contentRec && contentRec.chunkCount > 0) {
      for (let c = 0; c < contentRec.chunkCount; c++) {
        contentKeysToDelete.push(`${bookId}__chunk_${c}`);
      }
    }
    const settingsKeysToDelete = [`bookSearchHistory_${bookId}`];
    const assetKeys = await dbGetAllKeys("bookAssets");
    const matchingAssetKeys = assetKeys.filter(key => String(key).startsWith(`${bookId}::`));

    // Fase 1: Borrado autoritativo del registro canónico "books"
    const bookDel = await dbDelete("books", bookId);
    if (!bookDel.ok) {
      deletedBookIdsInSession.delete(bookId);
      return {
        ok: false,
        persistedToIdb: false,
        persistedToMemory: false,
        deletedBook: false,
        deletedFromIdb: false,
        deletedFromMemoryOnly: false,
        partial: false,
        pendingCleanupPersisted: false,
        orphanedAssetsPossible: false,
        failedStores: ["books"],
        error: bookDel.error || new Error("Failed deleting book record from IndexedDB")
      };
    }

    // Camino solo RAM (p. ej. !conn / IDB bloqueado): nunca informar borrado confirmado en disco ni borrar espejo
    if (!bookDel.persistedToIdb && bookDel.persistedToMemory) {
      revokeBookObjectUrls(`${bookId}::`);
      if (typeof hooks.onRevokeCover === "function") {
        try { hooks.onRevokeCover(bookId); } catch (e) {}
      }
      if (typeof hooks.onBeforeDeleteBook === "function") {
        try { hooks.onBeforeDeleteBook(bookId); } catch (e) {}
      }
      if (lastHydratedBookId === bookId) {
        lastHydratedBookId = null;
      }
      await dbDeleteBatch("bookContents", contentKeysToDelete, 40, { skipCleanupPrune: true });
      await dbDelete("settings", settingsKeysToDelete[0], { skipCleanupPrune: true });
      if (matchingAssetKeys.length > 0) {
        await dbDeleteBatch("bookAssets", matchingAssetKeys, 40, { skipCleanupPrune: true });
      }
      return {
        ok: false,
        persistedToIdb: false,
        persistedToMemory: true,
        deletedBook: false,
        deletedFromIdb: false,
        deletedFromMemoryOnly: true,
        partial: false,
        pendingCleanupPersisted: false,
        orphanedAssetsPossible: false,
        failedStores: [],
        error: null
      };
    }

    // Confirmado borrado en IndexedDB ("books" tx.oncomplete): limpiar espejo y estado de progreso de inmediato
    removeProgressMirror(bookId);
    pendingRecoveryProgressPatches.delete(bookId);
    knownDiskRevisionByBook.delete(bookId);
    knownDiskStateByBook.delete(bookId);
    bookSeqCounters.delete(bookId);
    bookInstanceIdByBook.delete(bookId);

    revokeBookObjectUrls(`${bookId}::`);
    if (typeof hooks.onRevokeCover === "function") {
      try { hooks.onRevokeCover(bookId); } catch (e) {}
    }
    if (typeof hooks.onBeforeDeleteBook === "function") {
      try { hooks.onBeforeDeleteBook(bookId); } catch (e) {}
    }
    if (lastHydratedBookId === bookId) {
      lastHydratedBookId = null;
    }

    // Fase 2: Limpieza de recursos asociados con verificación estricta de persistedToIdb
    const failedStores = [];
    let firstError = null;
    let remainingContentKeys = [];
    let remainingSettingsKeys = [];
    let remainingAssetKeys = [];

    const contentsDel = await dbDeleteBatch("bookContents", contentKeysToDelete, 40, { skipCleanupPrune: true });
    if (!contentsDel.ok || !contentsDel.persistedToIdb) {
      failedStores.push("bookContents");
      if (!firstError && contentsDel.error) firstError = contentsDel.error;
      remainingContentKeys = (Array.isArray(contentsDel.failedKeys) && contentsDel.failedKeys.length > 0)
        ? contentsDel.failedKeys
        : contentKeysToDelete.slice();
    }

    const searchDel = await dbDelete("settings", settingsKeysToDelete[0], { skipCleanupPrune: true });
    if (!searchDel.ok || !searchDel.persistedToIdb) {
      failedStores.push("settings");
      if (!firstError && searchDel.error) firstError = searchDel.error;
      remainingSettingsKeys = settingsKeysToDelete.slice();
    }

    if (matchingAssetKeys.length > 0) {
      const assetsDel = await dbDeleteBatch("bookAssets", matchingAssetKeys, 40, { skipCleanupPrune: true });
      if (!assetsDel.ok || !assetsDel.persistedToIdb) {
        failedStores.push("bookAssets");
        if (!firstError && assetsDel.error) firstError = assetsDel.error;
        remainingAssetKeys = (Array.isArray(assetsDel.failedKeys) && assetsDel.failedKeys.length > 0)
          ? assetsDel.failedKeys
          : matchingAssetKeys.slice();
      }
    }

    if (failedStores.length === 0) {
      return {
        ok: true,
        persistedToIdb: true,
        persistedToMemory: false,
        deletedBook: true,
        deletedFromIdb: true,
        deletedFromMemoryOnly: false,
        partial: false,
        pendingCleanupPersisted: false,
        orphanedAssetsPossible: false,
        failedStores: [],
        error: null
      };
    }

    const mergedCleanups = await loadMergedPendingAssetCleanups();
    mergedCleanups[bookId] = {
      bookId,
      bookInstanceId: capturedInstanceId,
      contentKeys: remainingContentKeys,
      assetKeys: remainingAssetKeys,
      settingsKeys: remainingSettingsKeys,
      failedStores: failedStores.slice(),
      failedAt: Date.now()
    };
    const cleanupPersistRes = await persistPendingAssetCleanupsMap(mergedCleanups);
    const pendingCleanupPersisted = Boolean(cleanupPersistRes.ok && cleanupPersistRes.persistedToIdb === true);

    return {
      ok: false,
      persistedToIdb: false,
      persistedToMemory: false,
      deletedBook: true,
      deletedFromIdb: true,
      deletedFromMemoryOnly: false,
      partial: true,
      pendingCleanupPersisted,
      orphanedAssetsPossible: !pendingCleanupPersisted,
      failedStores,
      error: firstError || cleanupPersistRes.error || null
    };
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
      getKnownDiskState: (bookId) => (knownDiskStateByBook.has(bookId) ? { ...knownDiskStateByBook.get(bookId) } : null),
      getBookInstanceId: (bookId) => (bookInstanceIdByBook.has(bookId) ? bookInstanceIdByBook.get(bookId) : null),
      getPendingRecoveryPatchesCount: () => pendingRecoveryProgressPatches.size,
      hasPendingRecoveryPatch: (bookId) => pendingRecoveryProgressPatches.has(bookId),
      readProgressMirror,
      getPendingAssetCleanupsRamCount: () => Object.keys(pendingAssetCleanupsRam).length,
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
      reconcileProgressMirrors,
      backfillMissingInstanceIds,
      flushPendingAssetCleanups,
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
