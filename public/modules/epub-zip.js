/**
 * Nyxen EPUB Reader - EPUB ZIP, Path, Image & Tag Helpers
 * Pure, reusable utilities for resolving EPUB archive paths, MIME types,
 * cover compression, and tag normalization.
 */
(function (globalScope) {
  "use strict";

  const zipLowerIndexCache = new WeakMap();

  function resolveZipPath(baseDir, relativePath) {
    if (!relativePath) return "";
    const cleanRel = String(relativePath).split("#")[0].split("?")[0];
    if (cleanRel.startsWith("/")) return cleanRel.slice(1);
    const stack = baseDir ? String(baseDir).split("/").filter(Boolean) : [];
    const parts = cleanRel.split("/");
    for (const p of parts) {
      if (p === "." || p === "") continue;
      if (p === "..") {
        if (stack.length > 0) stack.pop();
      } else {
        stack.push(p);
      }
    }
    return stack.join("/");
  }

  function findZipEntry(zip, path) {
    if (!zip || !path) return null;
    const noHash = String(path).split("#")[0].split("?")[0];
    let decoded = noHash;
    try { decoded = decodeURIComponent(noHash); } catch (e) {}
    const direct = zip.file(noHash) || zip.file(decoded);
    if (direct) return direct;
    let lowerMap = zipLowerIndexCache.get(zip);
    if (!lowerMap) {
      lowerMap = new Map();
      const names = Object.keys(zip.files || {});
      for (let i = 0; i < names.length; i++) {
        const k = names[i];
        if (!zip.files[k].dir) lowerMap.set(k.toLowerCase(), k);
      }
      zipLowerIndexCache.set(zip, lowerMap);
    }
    const matchKey = lowerMap.get(noHash.toLowerCase()) || lowerMap.get(decoded.toLowerCase());
    return matchKey ? (zip.file(matchKey) || null) : null;
  }

  function inferImageMimeType(path) {
    const p = String(path || "").toLowerCase();
    if (p.endsWith(".png")) return "image/png";
    if (p.endsWith(".webp")) return "image/webp";
    if (p.endsWith(".gif")) return "image/gif";
    if (p.endsWith(".svg")) return "image/svg+xml";
    return "image/jpeg";
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // Comprime portadas pesadas usando decodificación de bajo consumo de memoria (createImageBitmap) y libera el canvas de inmediato
  async function compressCoverToDataUrl(rawBytesOrBlob, mimeType = "image/jpeg", maxWidth = 260, maxHeight = 380, quality = 0.76) {
    let tempUrl = "";
    let bitmap = null;
    let canvas = null;
    try {
      const blob = rawBytesOrBlob instanceof Blob
        ? (rawBytesOrBlob.type ? rawBytesOrBlob : new Blob([rawBytesOrBlob], { type: mimeType }))
        : new Blob([rawBytesOrBlob], { type: mimeType });

      if (blob.size > 8 * 1024 * 1024) return null;
      if (mimeType === "image/svg+xml" && blob.size < 180000) {
        return await blobToDataURL(blob);
      }

      canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;

      if (typeof globalScope.createImageBitmap === "function") {
        try {
          bitmap = await globalScope.createImageBitmap(blob);
          let w = bitmap.width || maxWidth;
          let h = bitmap.height || maxHeight;
          if (w > maxWidth || h > maxHeight) {
            const ratio = Math.min(maxWidth / w, maxHeight / h);
            w = Math.max(1, Math.round(w * ratio));
            h = Math.max(1, Math.round(h * ratio));
          }
          canvas.width = w;
          canvas.height = h;
          ctx.fillStyle = "#18181b";
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(bitmap, 0, 0, w, h);
          bitmap.close();
          bitmap = null;
          return canvas.toDataURL("image/jpeg", quality);
        } catch (bmpErr) {
          if (bitmap) {
            try { bitmap.close(); } catch (e) {}
            bitmap = null;
          }
        }
      }

      tempUrl = URL.createObjectURL(blob);
      const img = await new Promise((resolve, reject) => {
        const imageEl = new Image();
        imageEl.onload = () => resolve(imageEl);
        imageEl.onerror = reject;
        imageEl.src = tempUrl;
      });

      let w = img.naturalWidth || img.width || maxWidth;
      let h = img.naturalHeight || img.height || maxHeight;
      if (w > maxWidth || h > maxHeight) {
        const ratio = Math.min(maxWidth / w, maxHeight / h);
        w = Math.max(1, Math.round(w * ratio));
        h = Math.max(1, Math.round(h * ratio));
      }

      canvas.width = w;
      canvas.height = h;
      ctx.fillStyle = "#18181b";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      img.src = "";
      return canvas.toDataURL("image/jpeg", quality);
    } catch (e) {
      return null;
    } finally {
      if (bitmap) {
        try { bitmap.close(); } catch (e) {}
      }
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      if (tempUrl) {
        try { URL.revokeObjectURL(tempUrl); } catch (e) {}
      }
    }
  }

  function normalizeBookTags(rawInput) {
    const tokens = [];
    const pushChunk = (chunk) => {
      if (!chunk) return;
      String(chunk).split(/[,;\n|]+/).forEach(part => {
        const trimmed = part.trim();
        if (!trimmed) return;
        if (trimmed.includes("#") && /\s/.test(trimmed)) {
          trimmed.split(/\s+/).forEach(w => { if (w) tokens.push(w); });
        } else {
          tokens.push(trimmed);
        }
      });
    };

    if (Array.isArray(rawInput)) rawInput.forEach(pushChunk);
    else pushChunk(rawInput);

    const seen = new Set();
    const result = [];
    for (const tok of tokens) {
      let cleaned = tok.replace(/^#+/, "").trim();
      if (!cleaned) continue;
      cleaned = cleaned
        .split(/\s+/)
        .filter(Boolean)
        .map((w, idx) => idx === 0 ? w : (w.charAt(0).toUpperCase() + w.slice(1)))
        .join("")
        .replace(/[^\p{L}\p{N}_-]/gu, "");
      if (cleaned.length < 2 || cleaned.length > 36) continue;
      const lower = cleaned.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        result.push(cleaned);
        if (result.length >= 24) break;
      }
    }
    return result;
  }

  globalScope.NyxenEpubZip = {
    resolveZipPath,
    findZipEntry,
    inferImageMimeType,
    blobToDataURL,
    compressCoverToDataUrl,
    normalizeBookTags
  };
})(window);
