/**
 * Nyxen EPUB Reader - Modular EPUB Processing Pipeline
 * Decomposes EPUB parsing into clear stages:
 *   1. Container & OPF loading
 *   2. Metadata & tags extraction
 *   3. Manifest, Spine & TOC (NAV/NCX) resolution
 *   4. Footnote collection
 *   5. Chapter & image asset streaming with cooperative yielding
 * Preserves exact bookRecord / asset storage contracts with NyxenStorage.
 */
(function (globalScope) {
  "use strict";

  const LIMITS = {
    MAX_SPINE_ITEMS: 2500,
    MAX_CHAPTER_HTML_BYTES: 6 * 1024 * 1024,
    MAX_FOOTNOTE_LENGTH: 1500,
    MAX_SINGLE_ASSET_BYTES: 1600 * 1024,
    MAX_TOTAL_ASSETS_BYTES: 24 * 1024 * 1024,
    MAX_INLINE_DATA_URL_LEN: 90000,
    ASSET_FLUSH_COUNT: 16,
    ASSET_FLUSH_BYTES: 3 * 1024 * 1024,
    COOPERATIVE_YIELD_MS: 18
  };

  function defaultCreateBookId() {
    if (globalScope.crypto && typeof globalScope.crypto.randomUUID === "function") {
      return `book_${globalScope.crypto.randomUUID()}`;
    }
    return `book_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  function defaultCountWords(html) {
    if (!html) return 0;
    const plain = String(html)
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z0-9#]+;/gi, " ");
    const m = plain.match(/\S+/g);
    return m ? m.length : 0;
  }

  function defaultIsExternalMediaUrl(rawUrl) {
    if (globalScope.NyxenSanitizer && typeof globalScope.NyxenSanitizer.isExternalMediaUrl === "function") {
      return globalScope.NyxenSanitizer.isExternalMediaUrl(rawUrl);
    }
    const s = String(rawUrl || "").replace(/[\u0000-\u0020\u007F]+/g, "").toLowerCase();
    return s.startsWith("http://") || s.startsWith("https://") || s.startsWith("http:") || s.startsWith("https:") || s.startsWith("//") || s.startsWith("ws://") || s.startsWith("wss://") || s.startsWith("ftp://");
  }

  const hooks = {
    getLang: () => "es",
    createBookId: defaultCreateBookId,
    countWords: defaultCountWords,
    sanitizeDom: null,
    isExternalMediaUrl: defaultIsExternalMediaUrl,
    saveAssetBatch: async (batch) => {
      if (globalScope.NyxenStorage && globalScope.NyxenStorage.assets) {
        return await globalScope.NyxenStorage.assets.saveBatch(batch, 16);
      }
      return false;
    },
    deleteBookOnError: async (bookId) => {
      if (globalScope.NyxenStorage && globalScope.NyxenStorage.books) {
        await globalScope.NyxenStorage.books.deleteWithAssets(bookId);
      }
    }
  };

  function configure(options = {}) {
    if (!options || typeof options !== "object") return;
    if (typeof options.getLang === "function") hooks.getLang = options.getLang;
    if (typeof options.createBookId === "function") hooks.createBookId = options.createBookId;
    if (typeof options.countWords === "function") hooks.countWords = options.countWords;
    if (typeof options.sanitizeDom === "function") hooks.sanitizeDom = options.sanitizeDom;
    if (typeof options.isExternalMediaUrl === "function") hooks.isExternalMediaUrl = options.isExternalMediaUrl;
    if (typeof options.saveAssetBatch === "function") hooks.saveAssetBatch = options.saveAssetBatch;
    if (typeof options.deleteBookOnError === "function") hooks.deleteBookOnError = options.deleteBookOnError;
  }

  function getZipHelpers() {
    const z = globalScope.NyxenEpubZip;
    if (!z) throw new Error("NyxenEpubZip module is required");
    return z;
  }

  async function readContainerAndOpf(zip, domParser) {
    const { findZipEntry } = getZipHelpers();
    const containerFile = findZipEntry(zip, "META-INF/container.xml") || findZipEntry(zip, "meta-inf/container.xml");
    if (!containerFile) throw new Error("Falta container.xml");

    const containerXml = await containerFile.async("text");
    delete zip.files[containerFile.name];
    const containerDoc = domParser.parseFromString(containerXml, "application/xml");
    const rootfile = containerDoc.querySelector("rootfile");
    if (!rootfile) throw new Error("Rootfile no encontrado");

    const opfPath = rootfile.getAttribute("full-path") || "";
    const opfDir = opfPath.includes("/") ? opfPath.substring(0, opfPath.lastIndexOf("/") + 1) : "";
    const opfFile = findZipEntry(zip, opfPath);
    if (!opfFile) throw new Error("OPF no encontrado");

    const opfXml = await opfFile.async("text");
    delete zip.files[opfFile.name];
    const opfDoc = domParser.parseFromString(opfXml, "application/xml");

    return { opfPath, opfDir, opfDoc };
  }

  function extractOpfMetadata(opfDoc, fileName) {
    const { normalizeBookTags } = getZipHelpers();

    const titleElem = opfDoc.querySelector("title") || opfDoc.getElementsByTagNameNS("*", "title")[0];
    const title = titleElem ? titleElem.textContent.trim() : String(fileName || "").replace(/\.epub$/i, "");

    const authorElem = opfDoc.querySelector("creator") || opfDoc.getElementsByTagNameNS("*", "creator")[0];
    const author = authorElem ? authorElem.textContent.trim() : "Autor Desconocido";

    const langElem = opfDoc.querySelector("language") || opfDoc.getElementsByTagNameNS("*", "language")[0];
    const language = langElem ? langElem.textContent.trim().toLowerCase() : "";

    const descElem = opfDoc.querySelector("description") || opfDoc.getElementsByTagNameNS("*", "description")[0];
    const rawDesc = descElem ? descElem.textContent.trim() : "";
    const description = rawDesc
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\/\s*p\s*>/gi, "\n\n")
      .replace(/<[^>]*>?/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const rawTagChunks = [];
    const subjectNodes = [
      ...opfDoc.querySelectorAll("subject"),
      ...opfDoc.getElementsByTagNameNS("*", "subject")
    ];
    subjectNodes.forEach(n => {
      const val = (n.textContent || "").trim();
      if (val) rawTagChunks.push(val);
    });
    opfDoc.querySelectorAll('meta[name="keywords"], meta[property="schema:keywords"], meta[name="tags"]').forEach(m => {
      const val = (m.getAttribute("content") || m.textContent || "").trim();
      if (val) rawTagChunks.push(val);
    });
    const inlineHashMatches = description.match(/#([A-Za-z0-9À-ÿ_-]{2,32})/g);
    if (inlineHashMatches) rawTagChunks.push(...inlineHashMatches);
    const tags = normalizeBookTags(rawTagChunks);

    return { title, author, language, description, tags };
  }

  function buildManifestAndSpine(opfDoc, opfDir) {
    const { resolveZipPath } = getZipHelpers();
    const manifest = {};
    const items = opfDoc.querySelectorAll("item");
    let coverHref = null;
    let coverId = null;
    let tocHref = null;
    let navHref = null;

    const metaCover = opfDoc.querySelector('meta[name="cover"]');
    if (metaCover) coverId = metaCover.getAttribute("content");

    items.forEach(item => {
      const id = item.getAttribute("id") || "";
      const href = item.getAttribute("href") || "";
      const mediaType = item.getAttribute("media-type") || "";
      const properties = item.getAttribute("properties") || "";
      const fullZipPath = resolveZipPath(opfDir, href);
      manifest[id] = { href: fullZipPath, mediaType, id };

      if (properties.includes("cover-image") || id === coverId || (id.toLowerCase().includes("cover") && mediaType.startsWith("image/"))) {
        coverHref = fullZipPath;
      }
      if (properties.includes("nav")) {
        navHref = fullZipPath;
      }
      if (mediaType === "application/x-dtbncx+xml" || href.toLowerCase().endsWith(".ncx")) {
        tocHref = fullZipPath;
      }
    });

    const spineItems = [];
    opfDoc.querySelectorAll("itemref").forEach(ref => {
      const idref = ref.getAttribute("idref");
      if (manifest[idref]) spineItems.push(manifest[idref]);
    });

    return { manifest, spineItems, coverHref, tocHref, navHref };
  }

  async function parseTocTitles(zip, domParser, { navHref, tocHref }) {
    const { resolveZipPath, findZipEntry } = getZipHelpers();
    const tocTitlesMap = {};

    const registerTocEntry = (baseDir, rawHref, label) => {
      if (!rawHref || !label) return;
      const cleanLabel = label.trim().replace(/\s+/g, " ");
      if (!cleanLabel) return;
      const resolved = resolveZipPath(baseDir, rawHref);
      let decoded = resolved;
      try { decoded = decodeURIComponent(resolved); } catch (e) {}
      if (!tocTitlesMap[resolved]) tocTitlesMap[resolved] = cleanLabel;
      if (!tocTitlesMap[decoded]) tocTitlesMap[decoded] = cleanLabel;
    };

    if (navHref) {
      const navEntry = findZipEntry(zip, navHref);
      if (navEntry) {
        try {
          const navDir = navHref.includes("/") ? navHref.substring(0, navHref.lastIndexOf("/") + 1) : "";
          const navDoc = domParser.parseFromString(await navEntry.async("text"), "text/html");
          navDoc.querySelectorAll("nav a[href]").forEach(a => {
            registerTocEntry(navDir, a.getAttribute("href"), a.textContent);
          });
        } catch (e) {}
      }
    }

    if (tocHref) {
      const ncxEntry = findZipEntry(zip, tocHref);
      if (ncxEntry) {
        try {
          const ncxDir = tocHref.includes("/") ? tocHref.substring(0, tocHref.lastIndexOf("/") + 1) : "";
          const ncxDoc = domParser.parseFromString(await ncxEntry.async("text"), "application/xml");
          ncxDoc.querySelectorAll("navPoint").forEach(np => {
            const txtEl = np.querySelector("navLabel > text");
            const contentEl = np.querySelector("content");
            if (txtEl && contentEl) {
              registerTocEntry(ncxDir, contentEl.getAttribute("src"), txtEl.textContent);
            }
          });
          delete zip.files[ncxEntry.name];
        } catch (e) {}
      }
    }

    return tocTitlesMap;
  }

  async function extractInitialCover(zip, coverHrefHint) {
    const { findZipEntry, inferImageMimeType, compressCoverToDataUrl } = getZipHelpers();
    let coverHref = coverHrefHint;

    if (!coverHref) {
      for (const filePath of Object.keys(zip.files)) {
        if (/(cover|portada|front)[^/]*\.(jpe?g|png|webp)/i.test(filePath)) {
          coverHref = filePath;
          break;
        }
      }
    }

    if (!coverHref) return null;
    const coverEntry = findZipEntry(zip, coverHref);
    if (!coverEntry) return null;

    try {
      const rawBytes = await coverEntry.async("uint8array");
      return await compressCoverToDataUrl(rawBytes, inferImageMimeType(coverHref));
    } catch (e) {
      return null;
    }
  }

  function createFootnoteCollector(maxLength = LIMITS.MAX_FOOTNOTE_LENGTH) {
    const referencedFootnoteIds = new Set();
    const footnotesMap = {};

    function storeFootnote(key, rawTxt) {
      if (!key || !rawTxt) return;
      const k = key.trim();
      const clean = rawTxt.trim().replace(/\s+/g, " ");
      if (/^\[?\s*\d+\s*\]?[.:)]?$/.test(clean) || clean.length < 2 || clean.length > maxLength) return;

      if (!footnotesMap[k] || clean.length > footnotesMap[k].length) {
        footnotesMap[k] = clean;
      }
      const lower = k.toLowerCase();
      if (!footnotesMap[lower] || clean.length > footnotesMap[lower].length) {
        footnotesMap[lower] = clean;
      }
      const tail = k.split(/[-_:]/).pop();
      if (tail && (!footnotesMap[tail] || clean.length > footnotesMap[tail].length)) {
        footnotesMap[tail] = clean;
      }
    }

    function extractCleanText(node) {
      if (!node) return "";
      const raw = (node.textContent || "").trim();
      if (!raw || raw.length > maxLength * 2) return "";
      const clone = node.cloneNode(true);
      clone.querySelectorAll("a, .backlink, .footnote-return, .reversefootnote").forEach(a => {
        if (a.textContent.match(/^[↩↑\^\[\]0-9\s:.-]+$/)) a.remove();
      });
      return clone.textContent.trim().replace(/\s+/g, " ");
    }

    function collectReferences(docNode) {
      if (!docNode) return;
      docNode.querySelectorAll("a[href*='#'], [epub\\:type*='noteref'], .noteref, .footnote-ref, sup a[href]").forEach(a => {
        const href = a.getAttribute("href") || "";
        if (href.includes("#")) {
          try {
            const hashId = decodeURIComponent(href.split("#")[1] || "").trim();
            if (hashId) referencedFootnoteIds.add(hashId);
          } catch (e) {}
        }
      });
    }

    function collectFromDoc(docNode) {
      if (!docNode) return;
      docNode.querySelectorAll("aside[epub\\:type*='footnote'], aside[epub\\:type*='endnote'], [role='doc-footnote'], [role='doc-endnote'], .footnote, .endnote").forEach(el => {
        const id = el.getAttribute("id");
        if (id) storeFootnote(id, extractCleanText(el));
      });

      docNode.querySelectorAll("li[id], aside[id], dd[id], p[id], div[id]").forEach(el => {
        const id = el.getAttribute("id");
        if (!id) return;
        if (/^(fn|note|ftn|endnote|foot|n[-_]?\d)/i.test(id) || referencedFootnoteIds.has(id)) {
          let targetNode = el;
          const directText = (el.textContent || "").trim();
          if (el.tagName === "SPAN" || /^\[?\s*\d+\s*\]?[.:)]?$/.test(directText)) {
            targetNode = el.closest("p, li, dd, aside, blockquote") || el.parentElement || el;
          }
          storeFootnote(id, extractCleanText(targetNode));
        }
      });

      referencedFootnoteIds.forEach(refId => {
        if (!refId || footnotesMap[refId]) return;
        const el = docNode.getElementById(refId);
        if (!el) return;
        let targetNode = el;
        const directText = (el.textContent || "").trim();
        if (el.tagName === "A" || el.tagName === "SUP" || el.tagName === "SPAN" || /^\[?\s*\d+\s*\]?[.:)]?$/.test(directText)) {
          targetNode = el.closest("p, li, dd, aside, blockquote") || el.parentElement || el;
        } else if (el.tagName === "DT" && el.nextElementSibling) {
          targetNode = el.nextElementSibling;
        }
        storeFootnote(refId, extractCleanText(targetNode));
      });
    }

    return {
      footnotesMap,
      collectReferences,
      collectFromDoc
    };
  }

  function resolveChapterTitle(chapterDoc, itemHref, chapterIndex, bookTitle, tocTitlesMap, lang) {
    let decodedHref = itemHref;
    try { decodedHref = decodeURIComponent(itemHref); } catch (e) {}
    let chapterTitle = tocTitlesMap[itemHref] || tocTitlesMap[decodedHref] || "";

    const hTitle = chapterDoc.querySelector("h1, h2, h3");
    if (!chapterTitle && hTitle && hTitle.textContent.trim()) {
      chapterTitle = hTitle.textContent.trim().substring(0, 80);
    }
    if (!chapterTitle) {
      const docTitle = chapterDoc.querySelector("title");
      if (docTitle && docTitle.textContent.trim() && docTitle.textContent.trim().toLowerCase() !== bookTitle.toLowerCase()) {
        chapterTitle = docTitle.textContent.trim().substring(0, 80);
      } else {
        chapterTitle = `${lang === "es" ? "Capítulo" : "Chapter"} ${chapterIndex + 1}`;
      }
    }
    return chapterTitle;
  }

  async function parseLocalEpub(file, options = {}) {
    const JSZipCtor = options.JSZip || globalScope.JSZip;
    if (typeof JSZipCtor === "undefined") {
      throw new Error("JSZip engine unavailable");
    }

    const lang = options.lang || hooks.getLang() || "es";
    const sanitizeDom = options.sanitizeDom || hooks.sanitizeDom;
    const isExternalUrl = options.isExternalMediaUrl || hooks.isExternalMediaUrl;
    const saveAssetBatch = options.saveAssetBatch || hooks.saveAssetBatch;
    const deleteBookOnError = options.deleteBookOnError || hooks.deleteBookOnError;
    const countWords = options.countWords || hooks.countWords;
    const createBookId = options.createBookId || hooks.createBookId;

    const { resolveZipPath, findZipEntry, inferImageMimeType, compressCoverToDataUrl } = getZipHelpers();

    const bookId = createBookId("book");
    // Cargar directamente desde el Blob/File sin duplicar todo el archivo en un ArrayBuffer adicional
    const zip = await JSZipCtor.loadAsync(file, { createFolders: false });
    const domParser = new DOMParser();

    const { opfDir, opfDoc } = await readContainerAndOpf(zip, domParser);
    const metadata = extractOpfMetadata(opfDoc, file && file.name);
    const { spineItems, coverHref, tocHref, navHref } = buildManifestAndSpine(opfDoc, opfDir);
    const tocTitlesMap = await parseTocTitles(zip, domParser, { navHref, tocHref });
    let coverDataUrl = await extractInitialCover(zip, coverHref);

    if (spineItems.length > LIMITS.MAX_SPINE_ITEMS) {
      throw new Error(lang === "es"
        ? `El EPUB excede el límite seguro de capítulos (${LIMITS.MAX_SPINE_ITEMS}).`
        : `EPUB exceeds safe chapter limit (${LIMITS.MAX_SPINE_ITEMS}).`);
    }

    const chapters = [];
    const seenAssets = new Set();
    const footnoteCollector = createFootnoteCollector(LIMITS.MAX_FOOTNOTE_LENGTH);

    let totalExtractedAssetBytes = 0;
    const pendingAssets = [];
    let pendingAssetBytes = 0;
    const omittedImages = {
      total: 0,
      singleLimit: 0,
      totalLimit: 0,
      inlineLimit: 0
    };
    const rejectedAssets = new Map();

    const flushPendingAssets = async () => {
      if (pendingAssets.length === 0) return;
      const batch = pendingAssets.splice(0, pendingAssets.length);
      pendingAssetBytes = 0;
      const ok = await saveAssetBatch(batch);
      if (!ok) {
        throw new Error(lang === "es"
          ? "No se pudieron guardar las imágenes del libro."
          : "Failed to save book images.");
      }
    };

    try {
      let importSliceStart = performance.now();
      for (let i = 0; i < spineItems.length; i++) {
        // Ceder por presupuesto de tiempo (18ms) en lugar de frenar cada 3 capítulos
        if (i > 0 && (performance.now() - importSliceStart) > LIMITS.COOPERATIVE_YIELD_MS) {
          await new Promise(r => setTimeout(r, 0));
          importSliceStart = performance.now();
        }

        const item = spineItems[i];
        const chapterFile = findZipEntry(zip, item.href);
        if (!chapterFile) continue;

        const htmlStr = await chapterFile.async("text");
        delete zip.files[chapterFile.name];
        if (htmlStr.length > LIMITS.MAX_CHAPTER_HTML_BYTES) {
          throw new Error(lang === "es"
            ? `El capítulo ${i + 1} supera el tamaño seguro permitido.`
            : `Chapter ${i + 1} exceeds safe size limit.`);
        }

        const chapterDoc = domParser.parseFromString(htmlStr, "text/html");
        if (typeof sanitizeDom === "function") {
          sanitizeDom(chapterDoc, { allowExternal: false });
        }

        footnoteCollector.collectReferences(chapterDoc);
        footnoteCollector.collectFromDoc(chapterDoc);

        const chapterDir = item.href.includes("/") ? item.href.substring(0, item.href.lastIndexOf("/") + 1) : "";
        const imgTags = chapterDoc.querySelectorAll("img, image");
        for (const img of imgTags) {
          if (img.hasAttribute("data-nyx-blocked-src")) {
            if (!img.getAttribute("alt")) {
              img.setAttribute("alt", lang === "es" ? "Imagen externa bloqueada" : "Blocked external image");
            }
            img.removeAttribute("src");
            img.removeAttribute("href");
            img.removeAttribute("xlink:href");
            img.removeAttribute("srcset");
            continue;
          }
          const src = img.getAttribute("src") || img.getAttribute("xlink:href") || img.getAttribute("href");
          if (!src) continue;
          if (src.startsWith("data:")) {
            // Evitar que imágenes Base64 gigantes incrustadas en el HTML desborden la memoria del capítulo
            if (src.length > LIMITS.MAX_INLINE_DATA_URL_LEN) {
              omittedImages.inlineLimit++;
              omittedImages.total++;
              img.remove();
            }
            continue;
          }
          if (isExternalUrl(src)) {
            img.setAttribute("data-nyx-blocked-src", src);
            img.setAttribute("data-nyx-blocked-badge", "1");
            if (!img.getAttribute("alt")) {
              img.setAttribute("alt", lang === "es" ? "Imagen externa bloqueada" : "Blocked external image");
            }
            img.removeAttribute("src");
            img.removeAttribute("href");
            img.removeAttribute("xlink:href");
            img.removeAttribute("srcset");
            continue;
          }

          const resolvedPath = resolveZipPath(chapterDir, src);
          const assetKey = `${bookId}::${resolvedPath}`;
          if (seenAssets.has(assetKey)) {
            img.setAttribute("data-nyx-asset", assetKey);
            img.removeAttribute("src");
            img.removeAttribute("href");
            img.removeAttribute("xlink:href");
            continue;
          }
          if (rejectedAssets.has(assetKey)) {
            const reason = rejectedAssets.get(assetKey);
            if (reason === "single") omittedImages.singleLimit++;
            else if (reason === "total") omittedImages.totalLimit++;
            omittedImages.total++;
            img.remove();
            continue;
          }

          const imgZip = findZipEntry(zip, resolvedPath);
          if (imgZip) {
            try {
              const needCover = !coverDataUrl && i <= 2;
              const needAsset = totalExtractedAssetBytes < LIMITS.MAX_TOTAL_ASSETS_BYTES;
              const rawBytes = (needCover || needAsset) ? await imgZip.async("uint8array") : null;
              if (needCover && rawBytes) {
                coverDataUrl = await compressCoverToDataUrl(rawBytes, inferImageMimeType(resolvedPath));
              }

              let rejectionReason = null;
              if (needAsset && rawBytes) {
                if (rawBytes.byteLength > LIMITS.MAX_SINGLE_ASSET_BYTES) {
                  rejectionReason = "single";
                } else if ((totalExtractedAssetBytes + rawBytes.byteLength) > LIMITS.MAX_TOTAL_ASSETS_BYTES) {
                  rejectionReason = "total";
                } else {
                  pendingAssets.push({
                    assetKey,
                    bookId,
                    buffer: rawBytes,
                    mimeType: inferImageMimeType(resolvedPath)
                  });
                  pendingAssetBytes += rawBytes.byteLength;
                  totalExtractedAssetBytes += rawBytes.byteLength;
                  seenAssets.add(assetKey);
                  if (pendingAssets.length >= LIMITS.ASSET_FLUSH_COUNT || pendingAssetBytes >= LIMITS.ASSET_FLUSH_BYTES) {
                    await flushPendingAssets();
                  }
                }
              } else if (!needAsset) {
                rejectionReason = "total";
              }
              delete zip.files[imgZip.name];
              if (seenAssets.has(assetKey)) {
                img.setAttribute("data-nyx-asset", assetKey);
                img.removeAttribute("src");
                img.removeAttribute("href");
                img.removeAttribute("xlink:href");
              } else {
                if (rejectionReason) {
                  rejectedAssets.set(assetKey, rejectionReason);
                  if (rejectionReason === "single") omittedImages.singleLimit++;
                  else if (rejectionReason === "total") omittedImages.totalLimit++;
                  omittedImages.total++;
                }
                img.remove();
              }
            } catch (e) {}
          } else {
            img.remove();
          }
        }

        const chapterTitle = resolveChapterTitle(chapterDoc, item.href, i, metadata.title, tocTitlesMap, lang);
        const chapterBodyHtml = chapterDoc.body ? chapterDoc.body.innerHTML : htmlStr;
        if (chapterDoc.body) chapterDoc.body.innerHTML = "";

        chapters.push({
          index: i,
          title: chapterTitle,
          href: item.href,
          html: chapterBodyHtml,
          isFavorite: false
        });
      }

      if (chapters.length === 0) {
        throw new Error(lang === "es"
          ? "El archivo EPUB no contiene capítulos legibles."
          : "This EPUB contains no readable chapters.");
      }

      await flushPendingAssets();
    } catch (parseErr) {
      pendingAssets.length = 0;
      await Promise.resolve(deleteBookOnError(bookId)).catch(() => {});
      throw parseErr;
    }

    // Liberar cualquier archivo restante del objeto JSZip
    for (const k of Object.keys(zip.files)) {
      delete zip.files[k];
    }

    const chapterWordCounts = chapters.map(c => countWords(c.html));

    const bookRecord = {
      id: bookId,
      title: metadata.title,
      author: metadata.author,
      language: metadata.language,
      description: metadata.description,
      tags: metadata.tags,
      cover: coverDataUrl,
      chapters,
      totalChapters: chapters.length,
      chapterWordCounts,
      currentChapter: 0,
      chapterScrollRatio: 0,
      chapterAnchor: null,
      hasStartedReading: false,
      allowExternalResources: false,
      status: "Leyendo",
      highlights: [],
      footnotes: footnoteCollector.footnotesMap
    };

    return { bookRecord, assetBlobs: [], omittedImages };
  }

  globalScope.NyxenEpub = {
    LIMITS,
    configure,
    parseLocalEpub,
    stages: {
      readContainerAndOpf,
      extractOpfMetadata,
      buildManifestAndSpine,
      parseTocTitles,
      extractInitialCover,
      createFootnoteCollector,
      resolveChapterTitle
    }
  };
})(window);
