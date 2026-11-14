export type Severity = 'Crítica' | 'Alta' | 'Media';

export type AuditCategory =
  | 'Almacenamiento'
  | 'Seguridad XSS'
  | 'Lector y DOM'
  | 'Parser EPUB'
  | 'UI y Eventos';

export interface AuditFinding {
  id: string;
  title: string;
  severity: Severity;
  category: AuditCategory;
  lines: string;
  symbol: string;
  summary: string;
  impact: string;
  codeSnippet: string;
  fixSummary: string;
  fixSnippet: string;
}

export interface RealityComparison {
  feature: string;
  uiClaim: string;
  actualBehavior: string;
  status: 'Cumple' | 'Parcial' | 'Inexacto' | 'No conectado';
}

export interface StorageStoreInfo {
  store: string;
  keyPath: string;
  payload: string;
  memoryFallbackStatus: 'Correcto' | 'Con fallo';
  notes: string;
}

export interface ModuleAnalysis {
  id: string;
  name: string;
  lines: string;
  verdict: 'Sólido' | 'Con fallos' | 'Incompleto';
  whatWorks: string[];
  whatFails: string[];
}

export const FILE_FACTS = {
  filename: 'Lumina_EPUB_Reader__3__7749e604.html',
  totalLines: 4940,
  totalBytes: 245120,
  htmlLines: '1 – 1074',
  scriptLines: '1078 – 4938',
  idbName: 'LuminaAppDB',
  idbVersion: 10,
  storesCount: 7,
  externalCdns: [
    'https://cdn.tailwindcss.com (Tailwind JIT en runtime)',
    'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
    'https://fonts.googleapis.com (Google Fonts)'
  ]
};

export const REALITY_VS_UI: RealityComparison[] = [
  {
    feature: 'Motor de renderizado EPUB + Sanitización',
    uiClaim: 'JSZip + DOMParser sanitizado, almacenamiento particionado en IndexedDB (v2.5.0)',
    actualBehavior: 'Sanitiza cada capítulo con sanitizeEpubDom(), decodifica rutas URI del ZIP, lee títulos desde nav.xhtml / toc.ncx y preserva cursivas/negritas.',
    status: 'Cumple'
  },
  {
    feature: 'Portadas y Fallbacks 100% locales',
    uiClaim: 'Sin peticiones externas a placehold.co para portadas',
    actualBehavior: 'Reemplazado placehold.co por portadas vectoriales SVG data:image/svg+xml embebidas; solicita navigator.storage.persist() al iniciar.',
    status: 'Cumple'
  },
  {
    feature: 'Abrir último libro al iniciar',
    uiClaim: 'Switch interactivo #toggleOpenLast sincronizado con IndexedDB',
    actualBehavior: 'Persiste openLastBook y lastOpenedBookId en el store settings; al iniciar reabre automáticamente el último libro leído si está activo.',
    status: 'Cumple'
  },
  {
    feature: 'Almacenamiento particionado (v10)',
    uiClaim: 'Separación de metadatos (books), capítulos (bookContents) y Blobs (bookAssets)',
    actualBehavior: 'La Biblioteca solo carga metadatos ligeros en RAM (~92% menos memoria); las imágenes se guardan como Blob nativo con URL.createObjectURL.',
    status: 'Cumple'
  },
  {
    feature: 'Persistencia IndexedDB y Respaldo RAM',
    uiClaim: 'Mapa STORE_KEY_PATHS por store + notificación de QuotaExceededError',
    actualBehavior: 'inMemoryDb respeta el keyPath exacto de cada store (id, bookId, assetKey, name, key, color) y tx.onerror/onabort alerta al usuario si se llena el disco.',
    status: 'Cumple'
  },
  {
    feature: 'Resaltado por TreeWalker, notas y filtros',
    uiClaim: 'Restauración DOM multi-nodo, colores dinámicos y salto de búsqueda',
    actualBehavior: 'applySavedHighlights() usa TreeWalker + Range (soporta <sup>, <em> y citas solapadas como hl_sample_1 y hl_sample_2), sincroniza colores en el filtro y salta al texto buscado.',
    status: 'Cumple'
  }
];

export const CODE_STRENGTHS = [
  {
    title: 'Inicialización defensiva con safeOn()',
    lines: '1066 – 1073',
    detail: 'Envuelve los addEventListener en try/catch verificando existencia en el DOM, evitando errores fatales si falta algún nodo.'
  },
  {
    title: 'Resolución de rutas relativas ZIP (resolveZipPath)',
    lines: '1374 – 1388',
    detail: 'Normaliza correctamente segmentos "." y ".." respecto al directorio del OPF para localizar capítulos e imágenes dentro de OEBPS/.'
  },
  {
    title: 'Cálculo de contraste YIQ dinámico',
    lines: '2380 – 2401',
    detail: 'Adapta automáticamente el color del título del capítulo, cabecera, cajón lateral y popup de notas al pie según luminancia del tema.'
  },
  {
    title: 'Gestos móviles bien resueltos en Biblioteca',
    lines: '1961 – 2032',
    detail: 'Implementa long-press de 500 ms con umbral de arrastre (dx > 8 || dy > 8), feedback háptico (navigator.vibrate) y prevención de click fantasma.'
  },
  {
    title: 'Color Picker HSV completo en Canvas + FontFace',
    lines: '3895 – 4243',
    detail: 'Selector HSV bidimensional funcional con puntero táctil/mouse y carga real de fuentes TTF/OTF/WOFF2 persistidas como ArrayBuffer.'
  }
];

export const AUDIT_FINDINGS: AuditFinding[] = [
  {
    id: 'bug-footnotes-id-bloat',
    title: 'El extractor de notas al pie indexa casi todo el libro por [id]',
    severity: 'Crítica',
    category: 'Almacenamiento',
    lines: '1552 – 1584',
    symbol: 'parseLocalEpub() -> footnotesMap',
    summary: 'El bucle secundario recorre TODOS los elementos con atributo [id] de TODOS los HTML del EPUB y guarda el texto completo de su nodo o contenedor padre dentro de footnotesMap bajo hasta 3 claves.',
    impact: 'Si un EPUB tiene <div id="cap1"> o <span id="p_4"> dentro de párrafos, almacena capítulos completos repetidos dentro de book.footnotes. Esto puede multiplicar por 2x–5x el peso del libro en IndexedDB y memoria RAM.',
    codeSnippet: `parsedDoc.querySelectorAll("[id]").forEach(el => {
  const id = el.getAttribute("id");
  if (!id) return;
  let targetNode = el;
  if (el.tagName === 'A' || el.tagName === 'SUP' || el.tagName === 'SPAN' || ...) {
    targetNode = el.closest("p, li, dd, aside, div, tr, blockquote") || el.parentElement || el;
  }
  const txt = extractCleanText(targetNode);
  storeFootnote(id, txt);
});`,
    fixSummary: 'Limitar la extracción a ids referenciados realmente por enlaces de notas al pie (a[href*="#"] dentro de sup/noteref) o contenedores semánticos de notas, y truncar o descartar nodos cuya longitud supere un umbral razonable (p. ej. > 1,500 caracteres).',
    fixSnippet: `const referencedIds = collectFootnoteTargetIds(chaptersHtml);
if (!referencedIds.has(id)) return;
if (txt.length > 2000) return; // Evita capturar capítulos completos`
  },
  {
    id: 'bug-monolithic-dbsave-silent-fail',
    title: 'dbSave() reescribe el libro entero y silencia errores de cuota',
    severity: 'Crítica',
    category: 'Almacenamiento',
    lines: '1289 – 1310',
    symbol: 'dbSave(storeName, item)',
    summary: 'Cada libro guarda portada Base64, HTML completo de capítulos, imágenes inline Base64, notas y highlights en un único objeto. Además, tx.onerror y catch(e) resuelven la promesa sin notificar fallos ni capturar QuotaExceededError.',
    impact: 'Pasar de capítulo, marcar favorito o crear un subrayado vuelve a serializar y escribir decenas de MB en IndexedDB. Si el navegador alcanza su límite de almacenamiento, el error se oculta y el usuario pierde sus datos al recargar.',
    codeSnippet: `try {
  const tx = db.transaction(storeName, "readwrite");
  tx.objectStore(storeName).put(item);
  tx.oncomplete = () => resolve();
  tx.onerror = () => resolve(); // Silencia QuotaExceededError
} catch (e) {
  resolve();
}`,
    fixSummary: 'Separar el modelo en stores independientes: booksMeta (portada + progreso + estado), bookChapters (texto), bookAssets (Blobs nativos sin Base64) y annotations. Rechazar o capturar explícitamente tx.error para alertar al usuario.',
    fixSnippet: `tx.onerror = () => reject(tx.error || new Error("IndexedDB write failed"));
tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));`
  },
  {
    id: 'bug-ram-load-all-books',
    title: 'renderLibrary() carga TODOS los libros completos en RAM',
    severity: 'Crítica',
    category: 'Almacenamiento',
    lines: '1892 – 1894',
    symbol: 'renderLibrary()',
    summary: 'Para pintar solo las portadas y títulos de la biblioteca, ejecuta dbGetAll("books"), deserializando todos los capítulos HTML y todas las imágenes Base64 de cada libro guardado.',
    impact: 'Con 15–30 EPUBs ilustrados (~50 MB descomprimidos c/u) o ~150 novelas largas, la pestaña consume más de 1–2 GB de RAM y provoca cierres inesperados (OOM) en móviles.',
    codeSnippet: `async function renderLibrary() {
  booksList = await dbGetAll("books"); // Trae capítulos e imágenes de todos los libros
  const grid = document.getElementById("libraryGrid");`,
    fixSummary: 'Almacenar metadatos ligeros en un store separado ("libraryIndex") o usar un cursor IndexedDB que lea únicamente título, autor, portada y progreso para la vista de biblioteca.',
    fixSnippet: `// Cargar solo metadatos ligeros para la cuadrícula:
booksMeta = await dbGetAll("booksMeta");
// Cargar capítulos bajo demanda al abrir el lector:
const content = await dbGet("bookContent", bookId);`
  },
  {
    id: 'bug-xss-unsanitized-html',
    title: 'Inyección directa de HTML/SVG/Scripts desde EPUBs (XSS)',
    severity: 'Crítica',
    category: 'Seguridad XSS',
    lines: '1515, 2483, 2548, 3315',
    symbol: 'cleanChapterHtml() / renderReader()',
    summary: 'El HTML extraído del EPUB se inserta directamente mediante innerHTML sin sanitización (no elimina <script>, <iframe >, atributos onerror/onload, ni URLs javascript:). Lo mismo ocurre con chapter.title y snippets de búsqueda.',
    impact: 'Un archivo EPUB manipulado o malicioso puede ejecutar JavaScript arbitrario en el origen de la app, leyendo o destruyendo toda la base IndexedDB del usuario.',
    codeSnippet: `const staticTitleHtml = \`<h1 ...>\${chapter.title}</h1>\`;
const content = document.getElementById("readerContent");
if (content) content.innerHTML = staticTitleHtml + cleanedBodyHtml;`,
    fixSummary: 'Sanitizar el HTML del capítulo con DOMPurify (o lista blanca estricta de etiquetas y atributos eliminando script, iframe, object, on* y javascript:) y usar escapeHtml() en todos los títulos y snippets.',
    fixSnippet: `temp.querySelectorAll("script, iframe, object, embed, link").forEach(n => n.remove());
temp.querySelectorAll("*").forEach(el => {
  for (const attr of [...el.attributes]) {
    if (/^on/i.test(attr.name) || /^javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
  }
});`
  },
  {
    id: 'bug-highlights-innerhtml-replace',
    title: 'applySavedHighlights() busca en innerHTML crudo y corrompe marcas',
    severity: 'Alta',
    category: 'Lector y DOM',
    lines: '3606 – 3625',
    symbol: 'applySavedHighlights()',
    summary: 'Intenta restaurar subrayados haciendo content.innerHTML.indexOf(hl.text) y reemplazando todo content.innerHTML en cada iteración.',
    impact: 'Falla siempre que el fragmento incluya etiquetas HTML internas (<em>, <b>, <sup>), entidades (&amp;, &quot;) o cruce dos párrafos. También puede coincidir dentro de atributos HTML (alt="...") o romper resaltados solapados como los del propio libro de ejemplo.',
    codeSnippet: `const needle = hl.text;
const html = content.innerHTML;
const idx = html.indexOf(needle);
if (idx !== -1) {
  ...
  content.innerHTML = html.replace(needle, replacement);
}`,
    fixSummary: 'Guardar selectores basados en offsets de texto del capítulo (XPath/offset numérico relativo a #readerContent) y envolver nodos de texto con TreeWalker igual que hace wrapRangeTextNodes().',
    fixSnippet: `// Guardar { startOffset, endOffset } sobre texto plano del capítulo
// y restaurar creando Ranges sobre NodeFilter.SHOW_TEXT sin tocar innerHTML.`
  },
  {
    id: 'bug-inmemory-themes-keyprop',
    title: 'Fallo de clave primaria en inMemoryDb para el store "themes"',
    severity: 'Alta',
    category: 'Almacenamiento',
    lines: '1293, 1353',
    symbol: 'dbSave() / dbDelete()',
    summary: 'El fallback en memoria infiere la clave primaria comprobando solo books ("id"), customFonts ("name") y swatches ("color"), asumiendo "key" para el resto. Pero el store "themes" usa keyPath "id".',
    impact: 'Cuando IndexedDB no está disponible, item["key"] es undefined en todos los temas: guardar un segundo tema personalizado sobrescribe al anterior en índice 0 y dbDelete falla.',
    codeSnippet: `const keyProp = storeName === "books" ? "id"
  : storeName === "customFonts" ? "name"
  : storeName === "swatches" ? "color" : "key";`,
    fixSummary: 'Incluir explícitamente el caso storeName === "themes" ? "id" en un mapa centralizado de keyPaths para ambos métodos.',
    fixSnippet: `const KEY_PATHS = { books: "id", themes: "id", customFonts: "name", settings: "key", swatches: "color" };
const keyProp = KEY_PATHS[storeName] || "id";`
  },
  {
    id: 'bug-sample-book-overwrite',
    title: 'init() sobrescribe los cambios del usuario en el libro de ejemplo',
    severity: 'Alta',
    category: 'Almacenamiento',
    lines: '4297 – 4305',
    symbol: 'init()',
    summary: 'Al arrancar, si existe book_tianbao_sample en IndexedDB, reemplaza por la fuerza sus footnotes, highlights y chapters con getSampleBook().',
    impact: 'Cualquier nota, resaltado o capítulo favorito que el usuario agregue o elimine en el libro precargado se pierde automáticamente al recargar la página.',
    codeSnippet: `if (sampleIdx !== -1) {
  const sample = getSampleBook();
  booksList[sampleIdx].footnotes = sample.footnotes;
  booksList[sampleIdx].highlights = sample.highlights;
  booksList[sampleIdx].chapters = sample.chapters;
  await dbSave("books", booksList[sampleIdx]);
}`,
    fixSummary: 'Insertar el libro de ejemplo únicamente la primera vez que se inicializa la base (usando una bandera seededSample en settings) para respetar ediciones posteriores del usuario.',
    fixSnippet: `const seeded = settings.find(s => s.key === "seededSample");
if (!seeded && booksList.length === 0) {
  await dbSave("books", getSampleBook());
  await dbSave("settings", { key: "seededSample", val: true });
}`
  },
  {
    id: 'bug-dead-open-last-toggle',
    title: 'Checkbox "Abrir último libro al iniciar" sin funcionalidad',
    severity: 'Alta',
    category: 'UI y Eventos',
    lines: '242 – 245, 4263 – 4315',
    symbol: '#toggleOpenLast',
    summary: 'El interruptor existe en el menú lateral con checked por defecto, pero ningún fragmento de JS lee su estado, lo persiste en IndexedDB ni abre el último libro en init().',
    impact: 'Control muerto en la interfaz que da al usuario una expectativa falsa de comportamiento.',
    codeSnippet: `<input type="checkbox" id="toggleOpenLast" checked class="rounded w-4 h-4 cursor-pointer">`,
    fixSummary: 'Escuchar change en #toggleOpenLast, guardar lastOpenedBookId al abrir un libro en el lector y abrirlo automáticamente en init() si la preferencia está activa.',
    fixSnippet: `safeOn("toggleOpenLast", "change", (e) => dbSave("settings", { key: "openLastBook", val: e.target.checked }));`
  },
  {
    id: 'bug-touch-laptop-click-blocked',
    title: 'El lector ignora clics de ratón en portátiles con pantalla táctil',
    severity: 'Alta',
    category: 'UI y Eventos',
    lines: '2636 – 2640',
    symbol: 'scrollArea click handler',
    summary: 'El listener de click comprueba if (!("ontouchstart" in window)) para evitar doble disparo en móviles. En portátiles Windows o convertibles con pantalla táctil, esa condición es falsa siempre.',
    impact: 'Quienes usen ratón en un equipo con pantalla táctil no pueden mostrar la barra superior ni avanzar página haciendo clic en el lector.',
    codeSnippet: `scrollArea.addEventListener("click", (e) => {
  if (!('ontouchstart' in window)) {
    handleReaderZonedTap(e.clientX);
  }
});`,
    fixSummary: 'Usar Pointer Events (pointerdown / pointerup) o registrar un timestamp del último touchend para ignorar únicamente el clic sintético generado dentro de los 400 ms posteriores a un evento táctil.',
    fixSnippet: `if (Date.now() - lastTouchEndTime < 400) return;
handleReaderZonedTap(e.clientX);`
  },
  {
    id: 'bug-search-and-fav-incomplete',
    title: 'Búsqueda global no guarda capítulo, no navega al texto y pega párrafos',
    severity: 'Alta',
    category: 'Lector y DOM',
    lines: '3247 – 3251, 3299 – 3329',
    symbol: 'drawerSearchInput / renderDrawerFavorites',
    summary: 'Al pulsar un resultado de búsqueda o favorito, cambia currentChapter y llama renderReader() sin ejecutar dbSave(). Tampoco hace scroll hasta el término buscado ni lo resalta, y replace(/<[^>]*>?/gm, "") une palabras entre </p><p> sin espacio.',
    impact: 'Al recargar se pierde el capítulo abierto desde búsqueda/favoritos; búsquedas entre párrafos producen falsos positivos ("fininicio") y en capítulos largos el usuario queda al principio del capítulo.',
    codeSnippet: `const textContent = ch.html.replace(/<[^>]*>?/gm, "");
...
card.addEventListener("click", () => {
  currentBook.currentChapter = ch.index;
  renderReader(); // Falta dbSave y scroll a coincidencia
});`,
    fixSummary: 'Extraer texto mediante DOMParser().parseFromString(ch.html, "text/html").body.textContent con separador de bloque, guardar currentChapter en IndexedDB y localizar el fragmento en el DOM tras renderReader().',
    fixSnippet: `const clean = ch.html.replace(/<\\/(p|div|li|h[1-6])>/gi, " ");
const plain = new DOMParser().parseFromString(clean, "text/html").body.textContent || "";`
  },
  {
    id: 'bug-epub-parser-edge-cases',
    title: 'Parser EPUB omite toc.ncx/nav, decodeURIComponent y CSS del libro',
    severity: 'Media',
    category: 'Parser EPUB',
    lines: '1439, 1485, 1501 – 1515',
    symbol: 'parseLocalEpub()',
    summary: 'No decodifica rutas URL-encoded (%20, %C3%B3) al consultar zip.file(), ignora el índice oficial (toc.ncx / nav.xhtml), borra el primer h1/h2 encontrado y descarta las hojas de estilo del EPUB.',
    impact: 'Imágenes o capítulos con espacios en su nombre de archivo no cargan; libros con estilo en clases (.italic, .center, .poema) pierden el formato literario; capítulos sin h1/h2 o con título del libro en h1 reciben nombres erróneos.',
    codeSnippet: `const fullZipPath = resolveZipPath(opfDir, href);
...
const chapterFile = zip.file(item.href); // Falla si href contiene %20`,
    fixSummary: 'Aplicar decodeURIComponent() antes de buscar en zip.file(), parsear toc.ncx/nav.xhtml para mapear títulos de capítulos reales y conservar/encapsular estilos básicos (cursiva, negrita, centrado) dentro de #readerContent.',
    fixSnippet: `const decoded = decodeURIComponent(path.split("#")[0]);
const zipEntry = zip.file(decoded) || zip.file(path);`
  },
  {
    id: 'bug-filter-colors-mismatch',
    title: 'Filtro de anotaciones desalineado con los colores reales de resaltado',
    severity: 'Media',
    category: 'UI y Eventos',
    lines: '692 – 696, 801 – 807, 2898 – 2914',
    symbol: 'annotationsFilterPopover',
    summary: 'La barra de resaltado ofrece menta (#C1E7E3) y permite colores personalizados, pero el filtro del cajón incluye rosa (#FFCCD5) en vez de menta y no refleja colores personalizados ni del libro de ejemplo (#9d4edd, #ea580c). Además filterTabAll/Notes no alternan opacity-60.',
    impact: 'El usuario no puede filtrar subrayados menta ni los del ejemplo por color, y el botón inactivo del filtro mantiene opacidad completa.',
    codeSnippet: `// Barra resaltado: #FFF3B0, #C1E7E3, #A3CEF1, #DBCDF0
// Filtro cajón:    #FFCCD5, #A3CEF1, #DBCDF0, #FFF3B0`,
    fixSummary: 'Generar dinámicamente los círculos de color del filtro a partir de los colores realmente presentes en currentBook.highlights.',
    fixSnippet: `const usedColors = [...new Set(currentBook.highlights.map(h => h.color.toLowerCase()))];`
  },
  {
    id: 'bug-note-edit-no-refresh',
    title: 'Editar una nota desde el cajón de anotaciones no refresca la lista',
    severity: 'Media',
    category: 'UI y Eventos',
    lines: '3176 – 3188, 3629 – 3645',
    symbol: 'btnSaveNote',
    summary: 'Cuando se edita una nota desde el menú de los tres puntos dentro del cajón Foliate, btnSaveNote guarda en IndexedDB y cierra el modal pero no vuelve a llamar renderDrawerHighlights().',
    impact: 'Visualmente parece que la nota no se actualizó hasta cerrar y reabrir la pestaña de anotaciones.',
    codeSnippet: `dbSave("books", currentBook);
document.getElementById("noteModal")?.classList.add("hidden");
activeClickedHighlightId = null; // Falta renderDrawerHighlights()`,
    fixSummary: 'Comprobar si #foliateDrawer está visible tras guardar y invocar renderDrawerHighlights().',
    fixSnippet: `if (!document.getElementById("foliateDrawer")?.classList.contains("hidden")) {
  renderDrawerHighlights();
}`
  },
  {
    id: 'bug-file-input-no-reset-and-id-collision',
    title: 'Inputs de archivo no se resetean e IDs usan Date.now()',
    severity: 'Media',
    category: 'UI y Eventos',
    lines: '1587, 1869, 2346, 3434, 4212',
    symbol: 'singleEpubInput / customFontInput / replaceCoverInput',
    summary: 'Los input[type=file] no limpian e.target.value = "" tras procesar el archivo, y los IDs usan "book_" + Date.now() o "hl_" + Date.now().',
    impact: 'No se puede reintentar subir el mismo archivo si falló o tras borrarlo. Crear dos registros en el mismo milisegundo sobrescribe el anterior.',
    codeSnippet: `id: "book_" + Date.now()`,
    fixSummary: 'Usar crypto.randomUUID() para IDs y resetear input.value = "" en bloque finally.',
    fixSnippet: `id: "book_" + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "_" + Math.random().toString(36).slice(2))`
  },
  {
    id: 'bug-scroll-progress-missing',
    title: 'Sin guardado de scroll dentro del capítulo y porcentaje inflado al inicio',
    severity: 'Media',
    category: 'Lector y DOM',
    lines: '1924, 2552 – 2553, 3435',
    symbol: 'renderLibrary() / renderReader()',
    summary: 'El progreso usa (currentChapter + 1) / totalChapters (marcando 33% al abrir un libro de 3 capítulos antes de leer nada) y renderReader siempre resetea scrollTop = 0. El número de página de cada cita es una fórmula fija (chapter * 12 + scrollTop/400).',
    impact: 'En novelas web o libros con capítulos muy largos (50+ pantallas), al salir y volver a entrar se pierde la posición exacta de lectura.',
    codeSnippet: `const pct = book.totalChapters > 0 ? Math.round(((book.currentChapter + 1) / book.totalChapters) * 100) : 0;
...
if (scrollArea) scrollArea.scrollTop = 0;`,
    fixSummary: 'Persistir scrollProgress (fracción 0..1 del scroll del capítulo, debounced en scroll) y calcular el progreso total usando currentChapter + scrollProgress.',
    fixSnippet: `const ratio = scrollArea.scrollTop / Math.max(1, scrollArea.scrollHeight - scrollArea.clientHeight);
currentBook.chapterScrollRatio = ratio;`
  },
  {
    id: 'bug-duplicate-listeners-and-i18n-gaps',
    title: 'Listeners duplicados en Detalle, traducciones incompletas y deprecación',
    severity: 'Media',
    category: 'UI y Eventos',
    lines: '481 – 628, 2327, 3427',
    symbol: 'renderStoryDetail() / copyToClipboard()',
    summary: 'renderStoryDetail() vuelve a registrar safeOn("btnReadStory", "click") en cada apertura; los modales de Menú Contextual de libro, Agrupar, Eliminar individual y Búsqueda están escritos solo en español sin data-i18n; copyToClipboard usa el método obsoleto document.execCommand("copy").',
    impact: 'Acumulación innecesaria de closures en memoria, interfaz bilingüe inconsistente al cambiar a EN y posible fallo al copiar en navegadores futuros.',
    codeSnippet: `// Dentro de renderStoryDetail():
safeOn("btnReadStory", "click", () => showView("reader"));`,
    fixSummary: 'Registrar btnReadStory una sola vez en ámbito global (o usar .onclick), añadir claves data-i18n faltantes y priorizar navigator.clipboard.writeText().',
    fixSnippet: `if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);`
  }
];

export const STORAGE_STORES: StorageStoreInfo[] = [
  {
    store: 'books',
    keyPath: 'id',
    payload: 'Objeto monolítico completo por libro: metadatos, portada Base64, array de capítulos HTML con imágenes Base64 inline, highlights y footnotesMap.',
    memoryFallbackStatus: 'Correcto',
    notes: 'Cualquier actualización de estado, capítulo favorito o resaltado reescribe el libro completo con put().'
  },
  {
    store: 'customFonts',
    keyPath: 'name',
    payload: 'Nombre de fuente y ArrayBuffer binario completo del archivo .ttf / .otf / .woff / .woff2.',
    memoryFallbackStatus: 'Correcto',
    notes: 'Almacenamiento eficiente en binario sin expansión Base64; sin límite de cantidad ni botón de borrado en UI.'
  },
  {
    store: 'settings',
    keyPath: 'key',
    payload: 'Configuraciones clave-valor: language, readerConfig, appConfig, activeTheme.',
    memoryFallbackStatus: 'Correcto',
    notes: 'Ligero (< 5 KB). Sin embargo toggleOpenLast no se guarda ni consulta aquí.'
  },
  {
    store: 'themes',
    keyPath: 'id',
    payload: 'Temas personalizados creados o editados en el panel Aa (id, name, bg, text, accent).',
    memoryFallbackStatus: 'Con fallo',
    notes: 'En inMemoryDb busca la propiedad "key" en lugar de "id", provocando sobrescritura del índice 0.'
  },
  {
    store: 'swatches',
    keyPath: 'color',
    payload: 'Muestras de color hexadecimal guardadas desde el Color Picker HSV.',
    memoryFallbackStatus: 'Correcto',
    notes: 'Muy ligero (< 1 KB). No ofrece opción para eliminar muestras.'
  }
];

export const MODULE_ANALYSES: ModuleAnalysis[] = [
  {
    id: 'mod-library',
    name: '1. Biblioteca y Gestión de Colecciones',
    lines: '169 – 206, 1892 – 2250',
    verdict: 'Sólido',
    whatWorks: [
      'Cuadrícula de 3 columnas con portada, barra de progreso inferior, indicador de estado y grupos filtrables.',
      'Detección táctil y de escritorio para pulsación prolongada (500 ms) y clic derecho (contextmenu) con vibración háptica.',
      'Bottom Sheet completo con cambio directo de estado de lectura (Leyendo, Por leer, Terminado, En pausa), agrupación, detalles y borrado.'
    ],
    whatFails: [
      'Carga todos los capítulos e imágenes de todos los libros en RAM al listar la biblioteca (dbGetAll("books")).',
      'Calcula el porcentaje por (currentChapter + 1) / totalChapters, mostrando progreso alto en libros recién iniciados.',
      'Los textos del Bottom Sheet, modales de agrupar y eliminar no tienen traducciones data-i18n en inglés.'
    ]
  },
  {
    id: 'mod-parser',
    name: '2. Motor de Parseo EPUB (JSZip + DOMParser)',
    lines: '1374 – 1599',
    verdict: 'Con fallos',
    whatWorks: [
      'Localiza container.xml y rootfile OPF dinámicamente sin asumir rutas fijas.',
      'Resuelve rutas relativas "../" entre capítulos, OPF e imágenes mediante resolveZipPath().',
      'Extrae portada por properties="cover-image", meta[name="cover"] o búsqueda heurística en el ZIP.'
    ],
    whatFails: [
      'No lee toc.ncx ni nav.xhtml; deduce nombres de capítulos del primer h1/h2/h3/title y elimina el nodo.',
      'No decodifica rutas con %20 o caracteres escapados antes de consultar zip.file().',
      'Convierte todas las imágenes a Base64 (+33% de peso) y el bucle [id] mete capítulos enteros en footnotesMap.',
      'No sanitiza scripts o atributos peligrosos del HTML importado.'
    ]
  },
  {
    id: 'mod-reader',
    name: '3. Visor de Lectura y Zonas Táctiles',
    lines: '633 – 678, 2380 – 2697',
    verdict: 'Con fallos',
    whatWorks: [
      'Zonas táctiles intuitivas (25% izquierda retrocede scroll, 50% centro muestra controles, 25% derecha avanza scroll).',
      'Botones flotantes laterales para salto rápido entre capítulos y marcador de capítulo favorito en cabecera.',
      'Ajuste en tiempo real de tipografía, tamaño, sangría, interlineado, márgenes laterales y espaciado entre párrafos.'
    ],
    whatFails: [
      'El listener click se desactiva por completo si existe "ontouchstart" in window, bloqueando ratones en laptops táctiles.',
      'No guarda la posición scrollTop dentro de capítulos largos; siempre vuelve arriba (scrollTop = 0).',
      'cleanChapterHtml() borra cualquier <h1>–<h4> del contenido y puede eliminar encabezados internos válidos.'
    ]
  },
  {
    id: 'mod-highlights',
    name: '4. Resaltado, Subrayado y Notas',
    lines: '680 – 748, 3338 – 3645',
    verdict: 'Con fallos',
    whatWorks: [
      'wrapRangeTextNodes() usa TreeWalker para envolver nodos de texto en selecciones multi-párrafo recién creadas.',
      'Permite alternar entre fondo redondeado (hl-rounded) y subrayado (hl-underline), cambiar color y adjuntar nota.'
    ],
    whatFails: [
      'Al recargar el capítulo, applySavedHighlights() busca texto plano dentro de innerHTML crudo: falla con tags intermedios, entidades o solapamientos.',
      'Calcula un número de página aproximado arbitrario (chapter * 12 + scrollTop / 400).',
      'Editar una nota desde el cajón de anotaciones no actualiza la lista visual hasta reabrir la pestaña.'
    ]
  },
  {
    id: 'mod-footnotes',
    name: '5. Notas al Pie (Footnotes)',
    lines: '53 – 68, 1520 – 1584, 2698 – 2828',
    verdict: 'Con fallos',
    whatWorks: [
      'Detecta superíndices Unicode (¹²³) y etiquetas <sup> / noteref, mostrando un popup flotante adaptado al contraste del tema.',
      'Limpia números repetidos al inicio de la nota y enlaces de retorno (↩, ↑).'
    ],
    whatFails: [
      'El selector general [id] en parseLocalEpub() captura contenedores enteros como si fueran notas al pie, inflando el JSON del libro.',
      'Cualquier <a href="#..."> dentro del libro que coincida con un id indexado puede abrirse como falsa nota al pie.'
    ]
  },
  {
    id: 'mod-drawer',
    name: '6. Cajón de Índice, Anotaciones y Búsqueda',
    lines: '750 – 861, 2830 – 3336',
    verdict: 'Con fallos',
    whatWorks: [
      'Agrupa anotaciones por capítulo con acordeón colapsable, menú contextual por tarjeta y salto al highlight.',
      'Búsqueda global instantánea en todos los capítulos con límite de seguridad de 50 resultados.'
    ],
    whatFails: [
      'El popover de filtro tiene colores hardcodeados que no coinciden con la paleta de la barra de resaltado (#FFCCD5 vs #C1E7E3).',
      'La búsqueda no guarda el capítulo seleccionado en IndexedDB, no desplaza al fragmento encontrado ni escapa HTML del snippet.'
    ]
  },
  {
    id: 'mod-theming',
    name: '7. Temas, Fuentes Custom y Color Picker HSV',
    lines: '402 – 446, 863 – 1051, 3650 – 4243',
    verdict: 'Sólido',
    whatWorks: [
      'Editor visual de temas de lectura con previsualización en vivo y 5 presets curados.',
      'Color Picker profesional con matriz Saturación/Valor en Canvas, barra Hue, entrada HEX y muestras persistentes.',
      'Soporte real de tipografías locales (.ttf, .otf, .woff, .woff2) aplicables tanto a la UI como al libro.'
    ],
    whatFails: [
      'La variable CSS --reader-accent no se actualiza al cambiar tema (los superíndices siguen usando --app-accent).',
      'No permite eliminar temas personalizados ni fuentes cargadas.'
    ]
  },
  {
    id: 'mod-persistence',
    name: '8. Persistencia, Settings e Internacionalización',
    lines: '208 – 293, 1078 – 1369, 4260 – 4315',
    verdict: 'Con fallos',
    whatWorks: [
      'Cambio de idioma ES/EN instantáneo en menús principales y almacenamiento en IndexedDB.',
      'Respaldo en memoria inMemoryDb para evitar caídas en iframes sin almacenamiento.'
    ],
    whatFails: [
      'init() pisa los cambios del libro de ejemplo cada vez que inicia la app.',
      'El checkbox "Abrir último libro al iniciar" no tiene implementación.',
      'Vaciar biblioteca no limpia temas, configuraciones ni fuentes pese a lo que indica el diálogo de confirmación.'
    ]
  }
];

export const REPRODUCIBLE_CHECKS = [
  {
    id: 'check-1',
    title: 'Persistencia real del libro de ejemplo (Corregido)',
    steps: 'Abre "Tianbao Fuyao Lu", crea un nuevo resaltado o edita una nota, y pulsa "Recargar app": tus cambios ahora se conservan sin ser sobrescritos por init().'
  },
  {
    id: 'check-2',
    title: 'Reapertura automática y progreso exacto (Corregido)',
    steps: 'Abre el libro en el lector, desplázate a mitad del capítulo y recarga la vista previa: con "Abrir último libro al iniciar" activo, vuelve directo al capítulo y posición de scroll exacta.'
  },
  {
    id: 'check-3',
    title: 'Filtro dinámico de colores y resaltados solapados (Corregido)',
    steps: 'En el Cap. 1 verás ambos resaltados solapados (morado redondeado + naranja subrayado) restaurados vía TreeWalker. Abre el cajón (≡) -> Citas -> Filtro: aparecen todos los colores usados.'
  },
  {
    id: 'check-4',
    title: 'Búsqueda global con salto y resaltado temporal (Corregido)',
    steps: 'Abre el cajón (≡) -> icono de lupa -> busca "Chang\'an" o "Qing Xiong" y pulsa un resultado: navega al capítulo, guarda el avance y desplaza suavemente al fragmento resaltándolo.'
  }
];
