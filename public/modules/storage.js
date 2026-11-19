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
  let dbInitBlocked = false;
  let lastHydratedBookId = null;

  const activeObjectUrls = new Map();

  // UI & state integration hooks configured by the host application
  const hooks = {
    onQuotaExceeded: null,
    onStatusChange: null,
    getBooksList: () => [],
    setBooksList: () => {},
    getCurrentBook: () => null,
    onBeforeDeleteBook: null,
    onRevokeCover: null
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
  }

  function notifyStatusChange() {
    if (typeof hooks.onStatusChange === "function") {
      try {
        hooks.onStatusChange({ blocked: dbInitBlocked, hasDb: Boolean(db) });
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

  function isUsingTempMemoryStorage() {
    return Boolean(dbInitBlocked || !db);
  }

  function isBlocked() {
    return Boolean(dbInitBlocked);
  }

  function hasDatabase() {
    return Boolean(db);
  }

  async function requestPersistentStorage() {
    try {
      if (navigator.storage && typeof navigator.storage.persist === "function") {
        const isPersisted = await navigator.storage.persisted();
        if (!isPersisted) await navigator.storage.persist();
      }
    } catch (e) {}
  }

  function openDatabase() {
    if (db) return Promise.resolve(db);
    if (dbOpeningPromise) return dbOpeningPromise;
    dbOpeningPromise = new Promise((resolve) => {
      if (!globalScope.indexedDB) {
        console.warn("IndexedDB no disponible, usando almacenamiento en memoria.");
        dbInitBlocked = true;
        notifyStatusChange();
        resolve(null);
        return;
      }

      let settled = false;
      const finish = (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(guardTimer);
        notifyStatusChange();
        resolve(val);
      };
      const guardTimer = setTimeout(() => {
        console.warn("IndexedDB tardó demasiado en abrir, usando fallback temporal.");
        dbInitBlocked = true;
        finish(null);
      }, 4500);

      try {
        const req = globalScope.indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const d = e.target.result;
          Object.entries(STORE_KEY_PATHS).forEach(([store, keyPath]) => {
            if (!d.objectStoreNames.contains(store)) {
              d.createObjectStore(store, { keyPath });
            }
          });
        };
        req.onsuccess = () => {
          db = req.result;
          dbInitBlocked = false;
          db.onversionchange = () => {
            try { db.close(); } catch (e) {}
            db = null;
          };
          db.onclose = () => {
            db = null;
          };
          finish(db);
        };
        req.onerror = () => {
          console.warn("IndexedDB bloqueado por permisos iframe, usando fallback en memoria.");
          dbInitBlocked = true;
          finish(null);
        };
        req.onblocked = () => {
          console.warn("IndexedDB bloqueado por otra pestaña.");
          dbInitBlocked = true;
          finish(null);
        };
      } catch (err) {
        console.warn("Excepción abriendo IndexedDB:", err);
        dbInitBlocked = true;
        finish(null);
      }
    }).finally(() => {
      dbOpeningPromise = null;
    });
    return dbOpeningPromise;
  }

  async function ensureDb() {
    if (db) return db;
    if (dbInitBlocked) return null;
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

  async function dbSave(storeName, item) {
    const conn = await ensureDb();
    return new Promise((resolve) => {
      if (!conn) {
        putInMemoryStore(storeName, item);
        resolve(true);
        return;
      }

      try {
        const tx = conn.transaction(storeName, "readwrite");
        tx.objectStore(storeName).put(item);
        tx.oncomplete = () => resolve(true);
        tx.onerror = (ev) => {
          const err = tx.error || ev?.target?.error;
          if (isQuotaError(err)) notifyQuotaExceeded();
          resolve(false);
        };
        tx.onabort = () => {
          if (isQuotaError(tx.error)) notifyQuotaExceeded();
          resolve(false);
        };
      } catch (e) {
        resolve(false);
      }
    });
  }

  async function dbGet(storeName, key) {
    const conn = await ensureDb();
    return new Promise((resolve) => {
      const keyProp = STORE_KEY_PATHS[storeName] || "key";
      if (!conn) {
        const list = inMemoryDb[storeName] || [];
        resolve(list.find(x => x && x[keyProp] === key) || null);
        return;
      }

      try {
        const tx = conn.transaction(storeName, "readonly");
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  }

  async function dbGetAll(storeName) {
    const conn = await ensureDb();
    return new Promise((resolve) => {
      if (!conn) {
        resolve(inMemoryDb[storeName] || []);
        return;
      }

      try {
        const tx = conn.transaction(storeName, "readonly");
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve(inMemoryDb[storeName] || []);
      } catch (e) {
        resolve(inMemoryDb[storeName] || []);
      }
    });
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

  async function saveBookMeta(book) {
    if (!book || !book.id) return false;
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
      rating: typeof book.rating === "number" && book.rating > 0 ? Math.min(5, Math.max(0.5, Math.round(book.rating * 2) / 2)) : 0,
      review: typeof book.review === "string" ? book.review : "",
      reviewedAt: typeof book.reviewedAt === "number" ? book.reviewedAt : 0,
      highlights: book.highlights || [],
      chapterWordCounts: Array.isArray(book.chapterWordCounts) ? book.chapterWordCounts : undefined,
      favoriteChapters: Array.isArray(book.chapters)
        ? book.chapters.filter(c => c.isFavorite).map(c => c.index)
        : (book.favoriteChapters || [])
    };

    const booksList = hooks.getBooksList();
    if (Array.isArray(booksList)) {
      const idx = booksList.findIndex(b => b.id === book.id);
      if (idx !== -1) {
        booksList[idx] = { ...booksList[idx], ...metaRecord };
        if (metaRecord.group === undefined) delete booksList[idx].group;
        if (metaRecord.groups === undefined) delete booksList[idx].groups;
      } else {
        booksList.push(metaRecord);
      }
    }

    const currentBook = hooks.getCurrentBook();
    if (currentBook && currentBook.id === book.id && currentBook !== book) {
      const preservedChapters = currentBook.chapters;
      const preservedFootnotes = currentBook.footnotes;
      Object.assign(currentBook, metaRecord);
      if (metaRecord.group === undefined) delete currentBook.group;
      if (metaRecord.groups === undefined) delete currentBook.groups;
      if (Array.isArray(preservedChapters) && preservedChapters.length > 0) {
        currentBook.chapters = preservedChapters;
      }
      if (preservedFootnotes) {
        currentBook.footnotes = preservedFootnotes;
      }
    }
    return await dbSave("books", metaRecord);
  }

  async function saveFullBookToDb(bookData, assetBlobs = []) {
    if (!bookData || !bookData.id) return false;
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

    const metaSaved = await saveBookMeta(bookData);
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
      isUsingTempMemoryStorage,
      isBlocked,
      hasDatabase,
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
