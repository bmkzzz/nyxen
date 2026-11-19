/**
 * Nyxen EPUB Reader - Content Sanitization & Security Module
 * Protects against XSS, dangerous URL protocols, SVG/CSS injection,
 * unauthorized external network requests, and malformed backup payloads
 * while preserving legitimate EPUB formatting, images, SVG art, and footnotes.
 */
(function (globalScope) {
  "use strict";

  const DANGEROUS_TAGS_SELECTOR = [
    "script", "iframe", "frame", "frameset", "portal",
    "object", "embed", "applet",
    "form", "input", "button", "textarea", "select", "option", "optgroup", "datalist", "fieldset", "output",
    "meta", "base", "link", "style",
    "noscript", "template", "plaintext", "xmp",
    "animate", "animatetransform", "animatemotion", "mpath", "set",
    "foreignobject", "handler", "listener", "discard"
  ].join(", ");

  const DANGEROUS_ATTR_NAMES = new Set([
    "srcdoc", "formaction", "action", "formmethod", "formenctype", "formtarget",
    "formnovalidate", "srcset", "imagesrcset", "ping", "dynsrc", "lowsrc",
    "xlink:actuate", "xlink:show", "autofocus"
  ]);

  const URL_ATTR_NAMES = new Set([
    "href", "src", "xlink:href", "poster", "background", "cite", "longdesc", "data", "codebase"
  ]);

  const SAFE_RASTER_IMAGE_MIMES = new Set([
    "image/png", "image/jpeg", "image/jpg", "image/gif",
    "image/webp", "image/bmp", "image/avif",
    "image/x-icon", "image/vnd.microsoft.icon"
  ]);

  const SAFE_MEDIA_DATA_MIMES = new Set([
    "audio/mpeg", "audio/mp3", "audio/ogg", "audio/wav", "audio/webm", "audio/aac", "audio/mp4",
    "video/mp4", "video/webm", "video/ogg"
  ]);

  const SAFE_BLOB_MIMES = new Set([
    "image/png", "image/jpeg", "image/jpg", "image/gif",
    "image/webp", "image/bmp", "image/avif"
  ]);

  const DEFAULT_BLOCKED_ALT_ES = "Imagen externa bloqueada";
  const DEFAULT_BLOCKED_ALT_EN = "Blocked external image";

  function stripControlAndTrim(raw) {
    return String(raw || "").replace(/^[\u0000-\u0020\u007F]+|[\u0000-\u0020\u007F]+$/g, "");
  }

  function compactForScheme(raw) {
    return String(raw || "").replace(/[\u0000-\u0020\u007F]+/g, "").toLowerCase();
  }

  function isExternalMediaUrl(rawUrl) {
    const compact = compactForScheme(rawUrl);
    if (!compact) return false;
    return (
      compact.startsWith("http://") ||
      compact.startsWith("https://") ||
      compact.startsWith("http:") ||
      compact.startsWith("https:") ||
      compact.startsWith("//") ||
      compact.startsWith("ws://") ||
      compact.startsWith("wss://") ||
      compact.startsWith("ftp://")
    );
  }

  function isSafeHttpUrl(rawUrl) {
    const cleaned = stripControlAndTrim(rawUrl);
    if (!cleaned || /[\u0000-\u001F\u007F"'<>]/.test(cleaned)) return false;
    return /^https?:\/\/[^"'<>\u0000-\u001F\u007F]+/i.test(cleaned) || /^\/\/[^/\\"'<>\u0000-\u001F\u007F]+/.test(cleaned);
  }

  function isDangerousProtocol(rawUrl) {
    const compact = compactForScheme(rawUrl);
    if (!compact) return false;
    return (
      compact.startsWith("javascript:") ||
      compact.startsWith("vbscript:") ||
      compact.startsWith("livescript:") ||
      compact.startsWith("mocha:") ||
      compact.startsWith("filesystem:") ||
      compact.startsWith("file:") ||
      compact.startsWith("chrome:") ||
      compact.startsWith("chrome-extension:") ||
      compact.startsWith("resource:") ||
      compact.startsWith("jar:") ||
      compact.startsWith("view-source:") ||
      compact.startsWith("about:")
    );
  }

  function decodeSvgDataPayload(dataUrl) {
    const commaIdx = dataUrl.indexOf(",");
    if (commaIdx === -1) return "";
    const meta = dataUrl.slice(5, commaIdx).toLowerCase();
    const payload = dataUrl.slice(commaIdx + 1);
    if (!payload) return "";
    try {
      if (meta.includes(";base64")) {
        const cleanB64 = payload.replace(/\s+/g, "");
        if (typeof globalScope.atob === "function") {
          return globalScope.atob(cleanB64);
        }
        if (typeof Buffer !== "undefined") {
          return Buffer.from(cleanB64, "base64").toString("utf8");
        }
        return "";
      }
      return decodeURIComponent(payload);
    } catch (e) {
      return "";
    }
  }

  function isSafeSvgMarkupSnippet(svgText) {
    if (!svgText) return false;
    const low = String(svgText).toLowerCase();
    if (
      /<script\b/.test(low) ||
      /<foreignobject\b/.test(low) ||
      /<iframe\b/.test(low) ||
      /<object\b/.test(low) ||
      /<embed\b/.test(low) ||
      /<animate/.test(low) ||
      /<set\b/.test(low) ||
      /<handler\b/.test(low) ||
      /<feimage\b/.test(low) ||
      /\bon[a-z0-9_-]+\s*=/.test(low) ||
      /javascript\s*:/.test(low) ||
      /vbscript\s*:/.test(low) ||
      /data\s*:\s*text\/html/.test(low) ||
      /(?:xlink:)?href\s*=\s*["']?\s*(?:https?:|\/\/|data:)/i.test(low)
    ) {
      return false;
    }
    return true;
  }

  function isSafeDataImageUrl(rawUrl, allowSvg = true) {
    const trimmed = stripControlAndTrim(rawUrl);
    const compact = compactForScheme(trimmed);
    if (!compact.startsWith("data:")) return false;
    const commaIdx = trimmed.indexOf(",");
    if (commaIdx === -1) return false;
    const header = trimmed.slice(5, commaIdx).replace(/[\u0000-\u0020\u007F]+/g, "").toLowerCase();
    const mime = header.split(";")[0] || "";
    if (SAFE_RASTER_IMAGE_MIMES.has(mime)) return true;
    if (allowSvg && mime === "image/svg+xml") {
      const decoded = decodeSvgDataPayload(trimmed);
      return isSafeSvgMarkupSnippet(decoded);
    }
    return false;
  }

  function isSafeDataMediaUrl(rawUrl) {
    const trimmed = stripControlAndTrim(rawUrl);
    const compact = compactForScheme(trimmed);
    if (!compact.startsWith("data:")) return false;
    const commaIdx = trimmed.indexOf(",");
    if (commaIdx === -1) return false;
    const header = trimmed.slice(5, commaIdx).replace(/[\u0000-\u0020\u007F]+/g, "").toLowerCase();
    const mime = header.split(";")[0] || "";
    return SAFE_MEDIA_DATA_MIMES.has(mime);
  }

  function normalizeAssetMimeType(rawMime, fallback = "image/jpeg") {
    const m = String(rawMime || "").split(";")[0].trim().toLowerCase();
    if (SAFE_BLOB_MIMES.has(m)) return m;
    if (m === "image/svg+xml") return "image/svg+xml";
    return fallback;
  }

  function sanitizeCoverUrl(rawUrl) {
    const trimmed = stripControlAndTrim(rawUrl);
    if (!trimmed) return "";
    if (/[\u0000-\u001F\u007F"'<>]/.test(trimmed)) return "";
    if (isDangerousProtocol(trimmed) || isExternalMediaUrl(trimmed)) return "";
    if (compactForScheme(trimmed).startsWith("data:")) {
      return isSafeDataImageUrl(trimmed, true) ? trimmed : "";
    }
    if (/^blob:/i.test(trimmed)) {
      return /^blob:(?:https?:\/\/|null\/)/i.test(trimmed) ? trimmed : "";
    }
    // Rutas relativas locales seguras (ej. /covers/default-1.png)
    if (/^\/?[a-zA-Z0-9_.\-/]+$/.test(trimmed)) {
      return trimmed;
    }
    return "";
  }

  function sanitizeCssColor(rawColor, fallback = "var(--app-accent)") {
    const s = stripControlAndTrim(rawColor);
    if (!s) return fallback;
    if (/[;{}<>\\"']|url\s*\(|expression\s*\(/i.test(s)) return fallback;
    if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
    if (/^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.,%\s+-]+\)$/i.test(s)) return s;
    if (/^var\(\s*--[a-zA-Z0-9_-]+\s*\)$/.test(s)) return s;
    if (/^[a-zA-Z]{3,24}$/.test(s)) return s;
    return fallback;
  }

  function decodeCssTextForCheck(text) {
    return String(text || "")
      .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, "")
      .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex) => {
        const cp = parseInt(hex, 16);
        if (!cp || cp > 0x10ffff) return "";
        try { return String.fromCodePoint(cp); } catch (e) { return ""; }
      })
      .replace(/\\([^\n\r\f0-9a-fA-F])/g, "$1");
  }

  function isAllowedCssUrlTarget(innerRaw, allowExternal) {
    let cleaned = stripControlAndTrim(innerRaw);
    if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
      cleaned = stripControlAndTrim(cleaned.slice(1, -1));
    }
    const decoded = decodeCssTextForCheck(cleaned);
    const candidate = stripControlAndTrim(decoded);
    if (!candidate) return true;
    if (isDangerousProtocol(candidate)) return false;
    if (compactForScheme(candidate).startsWith("data:")) {
      // En CSS solo permitir imágenes raster seguras (no text/html ni svg+xml)
      return isSafeDataImageUrl(candidate, false);
    }
    if (isExternalMediaUrl(candidate)) {
      return Boolean(allowExternal && isSafeHttpUrl(candidate));
    }
    return true;
  }

  function replaceCssUrlCalls(cssText, predicate) {
    const str = String(cssText || "");
    const len = str.length;
    let out = "";
    let i = 0;

    while (i < len) {
      const rest = str.slice(i);
      const m = rest.match(/^url\s*\(/i);
      if (!m) {
        out += str[i];
        i++;
        continue;
      }

      const start = i;
      i += m[0].length;
      let depth = 1;
      let quote = "";
      while (i < len && depth > 0) {
        const ch = str[i];
        if (quote) {
          if (ch === "\\" && i + 1 < len) {
            i += 2;
            continue;
          }
          if (ch === quote) quote = "";
        } else {
          if (ch === "\"" || ch === "'") quote = ch;
          else if (ch === "(") depth++;
          else if (ch === ")") depth--;
        }
        i++;
      }

      const fullCall = str.slice(start, i);
      const inner = depth === 0
        ? str.slice(start + m[0].length, i - 1)
        : str.slice(start + m[0].length, i);
      out += (depth === 0 && predicate(inner)) ? fullCall : "none";
    }
    return out;
  }

  function sanitizeInlineStyleUrls(styleText, allowExternal = false) {
    if (!styleText) return "";
    let out = String(styleText);
    const normalized = decodeCssTextForCheck(out);

    // Si hay escapes o comentarios junto a funciones/propiedades CSS sensibles, trabajar sobre la versión descodificada
    if (/[\\]|\/\*/.test(out) && /(?:expression\s*\(|behavior\s*:|-moz-binding\s*:|@import\b|-o-link|(?:url|image-set|cross-fade)\s*\()/i.test(normalized)) {
      out = normalized;
    }

    out = out
      .replace(/expression\s*\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)/gi, "")
      .replace(/expression\s*\(/gi, "")
      .replace(/behavior\s*:[^;]*/gi, "")
      .replace(/-moz-binding\s*:[^;]*/gi, "")
      .replace(/@import[^;]*(;|$)/gi, "")
      .replace(/-o-link(?:-source)?\s*:[^;]*/gi, "");

    out = replaceCssUrlCalls(out, (inner) => isAllowedCssUrlTarget(inner, allowExternal));

    // Bloquear image-set(...) / cross-fade(...) si contienen URLs externas no permitidas o peligrosas
    out = out.replace(/(?:(?:-webkit-)?image-set|cross-fade)\s*\(((?:[^()]|\([^()]*\))*)\)/gi, (fullMatch, inner) => {
      const dec = decodeCssTextForCheck(inner);
      if (isDangerousProtocol(dec) || /data\s*:\s*(?:text\/html|image\/svg\+xml|application\/)/i.test(dec) || (!allowExternal && /(https?:|\/\/|ws:|wss:|ftp:)/i.test(dec))) {
        return "none";
      }
      return fullMatch;
    });

    return out.trim();
  }

  function isSafeFragmentHref(rawHref) {
    const trimmed = stripControlAndTrim(rawHref);
    return trimmed.startsWith("#") && trimmed.length > 1 && !/[\u0000-\u0020\u007F"'<>]/.test(trimmed);
  }

  function sanitizeEpubDom(rootNode, options = {}) {
    if (!rootNode || typeof rootNode.querySelectorAll !== "function") {
      return { blockedExternalCount: 0 };
    }
    const allowExternal = Boolean(options && options.allowExternal);
    const lang = (options && options.lang) || "es";
    let blockedExternalCount = 0;
    let blockedNonImgExternalCount = 0;

    rootNode.querySelectorAll(DANGEROUS_TAGS_SELECTOR).forEach(el => el.remove());

    // Mitigación de mXSS en MathML annotation-xml con HTML/XHTML incrustado
    rootNode.querySelectorAll("annotation-xml").forEach(el => {
      const enc = (el.getAttribute("encoding") || "").toLowerCase();
      if (!enc || enc.includes("html")) el.remove();
    });

    rootNode.querySelectorAll("*").forEach(el => {
      const tag = (el.tagName || "").toUpperCase();
      let countedBlockedForEl = false;

      for (const attr of Array.from(el.attributes)) {
        const rawName = attr.name;
        const n = rawName.toLowerCase().trim();
        const rawVal = attr.value || "";

        if (n.startsWith("on") || DANGEROUS_ATTR_NAMES.has(n)) {
          el.removeAttribute(rawName);
          continue;
        }

        if (n === "style") {
          const cleanStyle = sanitizeInlineStyleUrls(rawVal, allowExternal);
          if (!cleanStyle) {
            el.removeAttribute(rawName);
          } else if (cleanStyle !== rawVal) {
            el.setAttribute(rawName, cleanStyle);
          }
          continue;
        }

        if (n === "data-nyx-blocked-src") {
          if (!isSafeHttpUrl(rawVal)) {
            el.removeAttribute(rawName);
            el.removeAttribute("data-nyx-blocked-badge");
          }
          continue;
        }

        if (!URL_ATTR_NAMES.has(n)) continue;

        if (isDangerousProtocol(rawVal)) {
          el.removeAttribute(rawName);
          continue;
        }

        const compactVal = compactForScheme(rawVal);

        // Restringir SVG <use> exclusivamente a referencias internas #id
        if (tag === "USE") {
          if (!isSafeFragmentHref(rawVal)) {
            el.removeAttribute(rawName);
          }
          continue;
        }

        // Control estricto de data: URLs según el elemento
        if (compactVal.startsWith("data:")) {
          if (tag === "IMG" || tag === "IMAGE" || (tag === "VIDEO" && n === "poster")) {
            if (!isSafeDataImageUrl(rawVal, tag !== "VIDEO")) {
              el.removeAttribute(rawName);
            }
          } else if (tag === "AUDIO" || tag === "VIDEO" || tag === "SOURCE") {
            if (!isSafeDataMediaUrl(rawVal)) {
              el.removeAttribute(rawName);
            }
          } else {
            el.removeAttribute(rawName);
          }
          continue;
        }

        // Bloquear/controlar cargas externas en elementos de medios o atributos de fondo
        if (isExternalMediaUrl(rawVal)) {
          if (tag === "A" || tag === "AREA") {
            if (!isSafeHttpUrl(rawVal)) {
              el.removeAttribute(rawName);
            } else {
              el.setAttribute("rel", "noopener noreferrer");
            }
            continue;
          }

          if (!allowExternal) {
            if (tag === "IMG" || tag === "IMAGE") {
              if (isSafeHttpUrl(rawVal)) {
                el.setAttribute("data-nyx-blocked-src", stripControlAndTrim(rawVal));
                el.setAttribute("data-nyx-blocked-badge", "1");
                if (!el.getAttribute("alt")) {
                  el.setAttribute("alt", lang === "es" ? DEFAULT_BLOCKED_ALT_ES : DEFAULT_BLOCKED_ALT_EN);
                }
              }
              el.removeAttribute(rawName);
              if (!countedBlockedForEl) {
                blockedExternalCount++;
                countedBlockedForEl = true;
              }
            } else {
              // Bloquear cargas externas en video, audio, source, track, feimage, [background], etc.
              el.removeAttribute(rawName);
              if (!countedBlockedForEl) {
                blockedExternalCount++;
                blockedNonImgExternalCount++;
                countedBlockedForEl = true;
              }
            }
          } else if (!isSafeHttpUrl(rawVal)) {
            el.removeAttribute(rawName);
          }
        }
      }
    });

    return { blockedExternalCount, blockedNonImgExternalCount };
  }

  function parseUntrustedHtml(rawHtml) {
    const htmlStr = String(rawHtml || "");
    if (typeof globalScope.DOMParser === "function") {
      try {
        const doc = new globalScope.DOMParser().parseFromString(htmlStr, "text/html");
        if (doc && doc.body) return doc;
      } catch (e) {}
    }
    if (globalScope.document && globalScope.document.implementation && typeof globalScope.document.implementation.createHTMLDocument === "function") {
      const inertDoc = globalScope.document.implementation.createHTMLDocument("");
      inertDoc.body.innerHTML = htmlStr;
      return inertDoc;
    }
    return null;
  }

  function sanitizeChapterHtmlString(rawHtml, options = {}) {
    const doc = parseUntrustedHtml(rawHtml);
    if (!doc || !doc.body) return "";
    sanitizeEpubDom(doc.body, options);
    const out = doc.body.innerHTML;
    doc.body.innerHTML = "";
    return out;
  }

  function sanitizeFootnotesMap(rawMap) {
    if (!rawMap || typeof rawMap !== "object") return {};
    const out = {};
    for (const [k, v] of Object.entries(rawMap)) {
      if (typeof k === "string" && typeof v === "string") {
        const cleanVal = v.trim();
        if (cleanVal) out[k] = cleanVal;
      }
    }
    return out;
  }

  globalScope.NyxenSanitizer = {
    isExternalMediaUrl,
    isSafeHttpUrl,
    isDangerousProtocol,
    isSafeDataImageUrl,
    isSafeDataMediaUrl,
    normalizeAssetMimeType,
    sanitizeCoverUrl,
    sanitizeCssColor,
    sanitizeInlineStyleUrls,
    sanitizeEpubDom,
    parseUntrustedHtml,
    sanitizeChapterHtmlString,
    sanitizeFootnotesMap
  };
})(window);
