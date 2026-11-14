import JSZip from 'jszip';

export interface EpubMeasurement {
  fileName: string;
  zipBytes: number;
  title: string;
  author: string;
  chapterCount: number;
  imageCount: number;
  chaptersRawHtmlBytes: number;
  coverDataUrlBytes: number;
  inlineImagesBase64Bytes: number;
  luminaFootnotesBytes: number;
  luminaFootnotesKeyCount: number;
  optimizedFootnotesBytes: number;
  luminaTotalRecordBytes: number;
  optimizedRecordBytes: number;
  inflationRatio: number;
}

function resolveZipPath(baseDir: string, relativePath: string): string {
  if (!relativePath) return '';
  if (relativePath.startsWith('/')) return relativePath.slice(1);
  const stack = baseDir ? baseDir.split('/').filter(Boolean) : [];
  const parts = relativePath.split('/');
  for (const p of parts) {
    if (p === '.' || p === '') continue;
    if (p === '..') {
      if (stack.length > 0) stack.pop();
    } else {
      stack.push(p);
    }
  }
  return stack.join('/');
}

function byteLength(str: string): number {
  return new TextEncoder().encode(str).length;
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Replica exactamente el algoritmo de parseLocalEpub() de Lumina para medir
 * cuánto crece realmente un archivo .epub al guardarse en IndexedDB.
 */
export async function measureEpubForLumina(file: File): Promise<EpubMeasurement> {
  const zip = await JSZip.loadAsync(file);
  const containerFile = zip.file('META-INF/container.xml') || zip.file('meta-inf/container.xml');
  if (!containerFile) throw new Error('Archivo EPUB inválido: falta META-INF/container.xml');

  const domParser = new DOMParser();
  const containerDoc = domParser.parseFromString(await containerFile.async('text'), 'application/xml');
  const rootfile = containerDoc.querySelector('rootfile');
  if (!rootfile) throw new Error('Archivo EPUB inválido: no se encontró rootfile');

  const opfPath = rootfile.getAttribute('full-path') || '';
  const opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';
  const opfFile = zip.file(opfPath);
  if (!opfFile) throw new Error('Archivo EPUB inválido: no se encontró el archivo OPF');

  const opfDoc = domParser.parseFromString(await opfFile.async('text'), 'application/xml');
  const titleElem = opfDoc.querySelector('title') || opfDoc.getElementsByTagNameNS('*', 'title')[0];
  const authorElem = opfDoc.querySelector('creator') || opfDoc.getElementsByTagNameNS('*', 'creator')[0];

  const title = titleElem?.textContent?.trim() || file.name.replace(/\.epub$/i, '');
  const author = authorElem?.textContent?.trim() || 'Autor desconocido';

  const manifest: Record<string, { href: string; mediaType: string; id: string }> = {};
  let coverHref: string | null = null;
  const metaCover = opfDoc.querySelector('meta[name="cover"]');
  const coverId = metaCover?.getAttribute('content') || null;

  opfDoc.querySelectorAll('item').forEach((item) => {
    const id = item.getAttribute('id') || '';
    const href = item.getAttribute('href') || '';
    const mediaType = item.getAttribute('media-type') || '';
    const properties = item.getAttribute('properties') || '';
    const fullZipPath = resolveZipPath(opfDir, href);
    manifest[id] = { href: fullZipPath, mediaType, id };

    if (
      properties.includes('cover-image') ||
      id === coverId ||
      (id.toLowerCase().includes('cover') && mediaType.startsWith('image/'))
    ) {
      coverHref = fullZipPath;
    }
  });

  if (!coverHref) {
    for (const filePath of Object.keys(zip.files)) {
      if (/cover\.(jpe?g|png|webp)/i.test(filePath)) {
        coverHref = filePath;
        break;
      }
    }
  }

  let coverDataUrlBytes = 0;
  if (coverHref && zip.file(coverHref)) {
    try {
      const b = await zip.file(coverHref)!.async('blob');
      const d = await blobToDataURL(b);
      coverDataUrlBytes = byteLength(d);
    } catch {
      coverDataUrlBytes = 0;
    }
  }

  const spineItems: Array<{ href: string; mediaType: string; id: string }> = [];
  opfDoc.querySelectorAll('itemref').forEach((ref) => {
    const idref = ref.getAttribute('idref') || '';
    if (manifest[idref]) spineItems.push(manifest[idref]);
  });

  let chaptersRawHtmlBytes = 0;
  let inlineImagesBase64Bytes = 0;
  let imageCount = 0;
  let chapterCount = 0;

  for (let i = 0; i < spineItems.length; i++) {
    const item = spineItems[i];
    const chapterFile = zip.file(item.href);
    if (!chapterFile) continue;
    chapterCount++;

    const htmlStr = await chapterFile.async('text');
    const chapterDoc = domParser.parseFromString(htmlStr, 'text/html');
    const chapterDir = item.href.includes('/') ? item.href.substring(0, item.href.lastIndexOf('/') + 1) : '';
    const imgTags = chapterDoc.querySelectorAll('img, image');

    let chapterImgBase64Bytes = 0;
    for (const img of Array.from(imgTags)) {
      const src = img.getAttribute('src') || img.getAttribute('xlink:href');
      if (src && !src.startsWith('data:') && !src.startsWith('http')) {
        const resolvedPath = resolveZipPath(chapterDir, src);
        const imgZip = zip.file(resolvedPath);
        if (imgZip) {
          imageCount++;
          try {
            const b = await imgZip.async('blob');
            const dUrl = await blobToDataURL(b);
            chapterImgBase64Bytes += byteLength(dUrl);
          } catch {
            // ignore image read error
          }
        }
      }
    }

    const bodyHtml = chapterDoc.body ? chapterDoc.body.innerHTML : htmlStr;
    chaptersRawHtmlBytes += byteLength(bodyHtml);
    inlineImagesBase64Bytes += chapterImgBase64Bytes;
  }

  // Simulación exacta del bug de footnotesMap en líneas 1521-1584
  const luminaFootnotesMap: Record<string, string> = {};
  const optimizedFootnotesMap: Record<string, string> = {};

  const storeFootnote = (map: Record<string, string>, key: string, rawTxt: string) => {
    if (!key || !rawTxt) return;
    const k = key.trim();
    const clean = rawTxt.trim().replace(/\s+/g, ' ');
    if (/^\[?\s*\d+\s*\]?[.:)]?$/.test(clean) || clean.length < 2) return;
    if (!map[k] || clean.length > map[k].length) map[k] = clean;
    const lower = k.toLowerCase();
    if (!map[lower] || clean.length > map[lower].length) map[lower] = clean;
    const tail = k.split(/[-_:]/).pop();
    if (tail && (!map[tail] || clean.length > map[tail].length)) map[tail] = clean;
  };

  for (const [filePath, zipEntry] of Object.entries(zip.files)) {
    if (/\.(xhtml|html|htm|xml)$/i.test(filePath) && !filePath.includes('META-INF') && !filePath.endsWith('.opf')) {
      try {
        const rawContent = await zipEntry.async('text');
        const parsedDoc = domParser.parseFromString(rawContent, 'text/html');

        parsedDoc
          .querySelectorAll("aside[epub\\:type*='footnote'], aside[epub\\:type*='endnote'], [role='doc-footnote'], [role='doc-endnote'], .footnote, .endnote")
          .forEach((el) => {
            const id = el.getAttribute('id');
            const txt = (el.textContent || '').trim().replace(/\s+/g, ' ');
            if (id && txt.length >= 2) {
              storeFootnote(luminaFootnotesMap, id, txt);
              if (txt.length <= 2000) optimizedFootnotesMap[id] = txt;
            }
          });

        parsedDoc.querySelectorAll('[id]').forEach((el) => {
          const id = el.getAttribute('id');
          if (!id) return;
          let targetNode: Element = el;
          const directText = (el.textContent || '').trim();
          if (el.tagName === 'A' || el.tagName === 'SUP' || el.tagName === 'SPAN' || /^\[?\s*\d+\s*\]?[.:)]?$/.test(directText)) {
            targetNode = el.closest('p, li, dd, aside, div, tr, blockquote') || el.parentElement || el;
          } else if (el.tagName === 'DT' && el.nextElementSibling) {
            targetNode = el.nextElementSibling;
          }
          const txt = (targetNode.textContent || '').trim().replace(/\s+/g, ' ');
          storeFootnote(luminaFootnotesMap, id, txt);
        });
      } catch {
        // ignore xml parse errors
      }
    }
  }

  const luminaFootnotesBytes = byteLength(JSON.stringify(luminaFootnotesMap));
  const optimizedFootnotesBytes = byteLength(JSON.stringify(optimizedFootnotesMap));
  const metadataOverhead = 1024;
  const luminaTotalRecordBytes =
    metadataOverhead + coverDataUrlBytes + chaptersRawHtmlBytes + inlineImagesBase64Bytes + luminaFootnotesBytes;

  // En modelo optimizado se guardan imágenes como Blobs nativos (~75% del Base64) y sin duplicación en footnotesMap
  const optimizedRecordBytes =
    metadataOverhead +
    Math.round(coverDataUrlBytes * 0.75) +
    chaptersRawHtmlBytes +
    Math.round(inlineImagesBase64Bytes * 0.75) +
    optimizedFootnotesBytes;

  return {
    fileName: file.name,
    zipBytes: file.size,
    title,
    author,
    chapterCount,
    imageCount,
    chaptersRawHtmlBytes,
    coverDataUrlBytes,
    inlineImagesBase64Bytes,
    luminaFootnotesBytes,
    luminaFootnotesKeyCount: Object.keys(luminaFootnotesMap).length,
    optimizedFootnotesBytes,
    luminaTotalRecordBytes,
    optimizedRecordBytes,
    inflationRatio: file.size > 0 ? Number((luminaTotalRecordBytes / file.size).toFixed(2)) : 1
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
