import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  FileUp,
  HardDrive,
  Layers,
  XCircle
} from 'lucide-react';
import { STORAGE_STORES } from '../data/auditData';
import {
  formatBytes,
  measureEpubForLumina,
  type EpubMeasurement
} from '../utils/epubStorageSimulator';

type BookProfileKey = 'novel' | 'illustrated' | 'heavy';
type DeviceProfileKey = 'chrome_desktop' | 'android_4gb' | 'ios_safari' | 'memory_fallback';

const BOOK_PROFILES: Record<
  BookProfileKey,
  { label: string; epubMb: number; luminaMultiplier: number; optimizedMultiplier: number; detail: string }
> = {
  novel: {
    label: 'Novela de texto (~1.2 MB .epub)',
    epubMb: 1.2,
    luminaMultiplier: 5.2,
    optimizedMultiplier: 2.8,
    detail: 'Texto XHTML descomprimido (~3x) + bug [id] en footnotesMap duplicando capítulos.'
  },
  illustrated: {
    label: 'Novela ilustrada (~12 MB .epub)',
    epubMb: 12,
    luminaMultiplier: 2.1,
    optimizedMultiplier: 1.35,
    detail: 'Imágenes convertidas a DataURL Base64 (+33% extra) + capítulos en HTML sin compresión.'
  },
  heavy: {
    label: 'Libro técnico / Manga (~45 MB .epub)',
    epubMb: 45,
    luminaMultiplier: 1.75,
    optimizedMultiplier: 1.15,
    detail: 'Decenas de imágenes en Base64 embebidas dentro de un único objeto JSON gigante.'
  }
};

const DEVICE_PROFILES: Record<
  DeviceProfileKey,
  { label: string; quotaMb: number; safeRamMb: number; note: string }
> = {
  chrome_desktop: {
    label: 'Chrome / Edge Escritorio',
    quotaMb: 8000,
    safeRamMb: 1500,
    note: 'Cuota amplia (~60% del disco libre), pero renderLibrary() carga todo en RAM a la vez.'
  },
  android_4gb: {
    label: 'Android gama media (4 GB RAM)',
    quotaMb: 2500,
    safeRamMb: 380,
    note: 'La pestaña suele cerrarse por OOM mucho antes de llenar el almacenamiento en disco.'
  },
  ios_safari: {
    label: 'Safari iOS (iPhone / iPad)',
    quotaMb: 1000,
    safeRamMb: 320,
    note: 'Cuota estricta (~1 GB por origen) y borrado automático tras 7 días sin abrir el sitio.'
  },
  memory_fallback: {
    label: 'Iframe / Navegación privada (inMemoryDb)',
    quotaMb: 0,
    safeRamMb: 250,
    note: 'Persistencia cero: todo se guarda solo en RAM y se pierde al recargar o cerrar.'
  }
};

interface BrowserStorageState {
  supported: boolean;
  usageBytes: number | null;
  quotaBytes: number | null;
  persisted: boolean | null;
  idbAvailable: boolean;
}

export function StorageSection() {
  const [browserStorage, setBrowserStorage] = useState<BrowserStorageState>({
    supported: false,
    usageBytes: null,
    quotaBytes: null,
    persisted: null,
    idbAvailable: typeof window !== 'undefined' && 'indexedDB' in window
  });

  const [bookProfile, setBookProfile] = useState<BookProfileKey>('novel');
  const [deviceProfile, setDeviceProfile] = useState<DeviceProfileKey>('android_4gb');
  const [bookCount, setBookCount] = useState<number>(35);

  const [measuring, setMeasuring] = useState(false);
  const [measureError, setMeasureError] = useState<string | null>(null);
  const [measurement, setMeasurement] = useState<EpubMeasurement | null>(null);

  useEffect(() => {
    let active = true;
    async function probe() {
      if (!navigator.storage?.estimate) return;
      try {
        const est = await navigator.storage.estimate();
        const pers = navigator.storage.persisted ? await navigator.storage.persisted() : null;
        if (!active) return;
        setBrowserStorage({
          supported: true,
          usageBytes: typeof est.usage === 'number' ? est.usage : null,
          quotaBytes: typeof est.quota === 'number' ? est.quota : null,
          persisted: pers,
          idbAvailable: 'indexedDB' in window
        });
      } catch {
        // Ignorar si el navegador bloquea storage.estimate
      }
    }
    probe();
    return () => {
      active = false;
    };
  }, []);

  const simulation = useMemo(() => {
    const bp = BOOK_PROFILES[bookProfile];
    const dp = DEVICE_PROFILES[deviceProfile];

    const luminaPerBookMb = bp.epubMb * bp.luminaMultiplier;
    const optimizedPerBookMb = bp.epubMb * bp.optimizedMultiplier;

    const totalLuminaMb = luminaPerBookMb * bookCount;
    const totalOptimizedMb = optimizedPerBookMb * bookCount;

    // En Lumina, renderLibrary() ejecuta dbGetAll("books"), cargando todo + overhead de parsing V8 (~1.4x)
    const luminaLibraryRamMb = totalLuminaMb * 1.4;
    // En modelo separado solo carga portadas e índice (~0.18 MB por libro)
    const optimizedLibraryRamMb = bookCount * 0.18;

    const maxByQuota = dp.quotaMb === 0 ? 0 : Math.floor(dp.quotaMb / luminaPerBookMb);
    const maxByRam = Math.floor(dp.safeRamMb / (luminaPerBookMb * 1.4));
    const realisticMaxBooks = dp.quotaMb === 0 ? maxByRam : Math.min(maxByQuota, maxByRam);

    let bottleneck = 'Operación dentro de margen seguro';
    let riskLevel: 'nominal' | 'warning' | 'critical' = 'nominal';

    if (deviceProfile === 'memory_fallback') {
      bottleneck = 'Sin persistencia en disco: al cerrar la pestaña se pierden todos los libros';
      riskLevel = 'critical';
    } else if (luminaLibraryRamMb > dp.safeRamMb) {
      bottleneck = `Colapso de RAM en renderLibrary() antes de llenar IndexedDB (máx. seguro ~${maxByRam} libros)`;
      riskLevel = 'critical';
    } else if (totalLuminaMb > dp.quotaMb) {
      bottleneck = `Supera la cuota de IndexedDB del navegador (~${maxByQuota} libros) con fallo silencioso en dbSave()`;
      riskLevel = 'critical';
    } else if (luminaLibraryRamMb > dp.safeRamMb * 0.7 || totalLuminaMb > dp.quotaMb * 0.7) {
      bottleneck = 'Acercándose al límite seguro de memoria o cuota del dispositivo';
      riskLevel = 'warning';
    }

    return {
      bp,
      dp,
      luminaPerBookMb,
      optimizedPerBookMb,
      totalLuminaMb,
      totalOptimizedMb,
      luminaLibraryRamMb,
      optimizedLibraryRamMb,
      maxByQuota,
      maxByRam,
      realisticMaxBooks,
      bottleneck,
      riskLevel
    };
  }, [bookProfile, deviceProfile, bookCount]);

  async function handleEpubUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setMeasuring(true);
    setMeasureError(null);
    try {
      const result = await measureEpubForLumina(file);
      setMeasurement(result);
    } catch (err) {
      setMeasureError(err instanceof Error ? err.message : 'No se pudo analizar el archivo EPUB.');
      setMeasurement(null);
    } finally {
      setMeasuring(false);
    }
  }

  return (
    <div className="space-y-8">
      {/* Telemetría real del navegador actual */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-200 dark:border-slate-800">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              Capacidad de almacenamiento en tu navegador actual
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Medición directa mediante navigator.storage.estimate() sobre este origen
            </p>
          </div>
          <HardDrive className="w-5 h-5 text-slate-400 shrink-0" />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 pt-5">
          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Cuota disponible estimada</div>
            <div className="mt-1 text-xl font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100">
              {browserStorage.quotaBytes !== null ? formatBytes(browserStorage.quotaBytes) : 'No expuesta'}
            </div>
            <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Uso actual del origen: {browserStorage.usageBytes !== null ? formatBytes(browserStorage.usageBytes) : '—'}
            </div>
          </div>

          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Persistencia garantizada (persist)</div>
            <div className="mt-1 text-xl font-semibold text-amber-600 dark:text-amber-400">
              {browserStorage.persisted === true ? 'Activa' : 'Best-Effort (Volátil)'}
            </div>
            <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Lumina nunca invoca navigator.storage.persist()
            </div>
          </div>

          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Soporte IndexedDB</div>
            <div className="mt-1 text-xl font-semibold text-emerald-700 dark:text-emerald-400">
              {browserStorage.idbAvailable ? 'Disponible' : 'Bloqueado (Fallback RAM)'}
            </div>
            <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Base de Lumina: LuminaAppDB (v9)
            </div>
          </div>
        </div>
      </div>

      {/* Simulador interactivo de capacidad y RAM */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-6">
        <div>
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Simulador de capacidad: cuántos libros soporta Lumina antes de fallar
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Calcula el consumo real en IndexedDB y el pico de memoria RAM causado por dbGetAll(&quot;books&quot;) al abrir la biblioteca
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              Tipo de EPUB promedio
            </label>
            <select
              value={bookProfile}
              onChange={(e) => setBookProfile(e.target.value as BookProfileKey)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-400"
            >
              {Object.entries(BOOK_PROFILES).map(([key, cfg]) => (
                <option key={key} value={key}>
                  {cfg.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              {simulation.bp.detail}
            </p>
          </div>

          <div className="space-y-2">
            <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
              Entorno / Dispositivo
            </label>
            <select
              value={deviceProfile}
              onChange={(e) => setDeviceProfile(e.target.value as DeviceProfileKey)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-slate-400"
            >
              {Object.entries(DEVICE_PROFILES).map(([key, cfg]) => (
                <option key={key} value={key}>
                  {cfg.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              {simulation.dp.note}
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs font-semibold text-slate-700 dark:text-slate-300">
              <label htmlFor="bookCountRange">Libros en biblioteca</label>
              <span className="font-mono tabular-nums text-slate-900 dark:text-slate-100">
                {bookCount} libros
              </span>
            </div>
            <input
              id="bookCountRange"
              type="range"
              min={1}
              max={250}
              value={bookCount}
              onChange={(e) => setBookCount(Number(e.target.value))}
              className="w-full accent-slate-900 dark:accent-slate-100 cursor-pointer"
            />
            <div className="flex justify-between text-xs font-mono tabular-nums text-slate-400">
              <span>1</span>
              <span>125</span>
              <span>250</span>
            </div>
          </div>
        </div>

        {/* Resultados comparativos */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 pt-5 border-t border-slate-200 dark:border-slate-800">
          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Peso en IndexedDB (Lumina actual)</div>
            <div className="mt-1 text-xl font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100">
              {simulation.totalLuminaMb.toFixed(1)} MB
            </div>
            <div className="mt-0.5 text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
              ~{simulation.luminaPerBookMb.toFixed(1)} MB por libro
            </div>
          </div>

          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Peso con diseño separado (Blobs)</div>
            <div className="mt-1 text-xl font-semibold font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
              {simulation.totalOptimizedMb.toFixed(1)} MB
            </div>
            <div className="mt-0.5 text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
              ~{simulation.optimizedPerBookMb.toFixed(1)} MB por libro
            </div>
          </div>

          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">RAM usada al abrir Biblioteca</div>
            <div
              className={`mt-1 text-xl font-semibold font-mono tabular-nums ${
                simulation.luminaLibraryRamMb > simulation.dp.safeRamMb
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-slate-900 dark:text-slate-100'
              }`}
            >
              {simulation.luminaLibraryRamMb.toFixed(0)} MB
            </div>
            <div className="mt-0.5 text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
              Optimizado: ~{simulation.optimizedLibraryRamMb.toFixed(1)} MB
            </div>
          </div>

          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Límite práctico seguro</div>
            <div className="mt-1 text-xl font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100">
              {deviceProfile === 'memory_fallback' ? '0 persistentes' : `~${Math.max(0, simulation.realisticMaxBooks)} libros`}
            </div>
            <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Por cuota y RAM sin congelar UI
            </div>
          </div>
        </div>

        {/* Diagnóstico del cuello de botella */}
        <div className="pt-4 border-t border-slate-200 dark:border-slate-800 flex items-start gap-2.5 text-sm">
          {simulation.riskLevel === 'critical' ? (
            <XCircle className="w-4 h-4 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
          ) : simulation.riskLevel === 'warning' ? (
            <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-emerald-700 dark:text-emerald-400 mt-0.5 shrink-0" />
          )}
          <span className="text-slate-700 dark:text-slate-300">{simulation.bottleneck}</span>
        </div>
      </div>

      {/* Analizador real de EPUB con JSZip */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Probador real de archivo .epub (replicando parseLocalEpub)
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Sube cualquier EPUB local para medir exactamente cuánto se infla en IndexedDB por Base64 y por el bug de [id] en footnotesMap
            </p>
          </div>

          <label className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 text-xs font-semibold cursor-pointer hover:opacity-90 transition-opacity whitespace-nowrap shrink-0">
            <FileUp className="w-4 h-4 shrink-0" />
            <span>{measuring ? 'Analizando EPUB...' : 'Medir archivo .epub'}</span>
            <input
              type="file"
              accept=".epub"
              onChange={handleEpubUpload}
              disabled={measuring}
              className="hidden"
            />
          </label>
        </div>

        {measureError && (
          <div className="p-3 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-xs text-red-700 dark:text-red-300">
            {measureError}
          </div>
        )}

        {measurement ? (
          <div className="space-y-5 pt-2 border-t border-slate-200 dark:border-slate-800">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span className="font-semibold text-slate-900 dark:text-slate-100">{measurement.title}</span>
              <span aria-hidden="true">·</span>
              <span>{measurement.author}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">{measurement.chapterCount} capítulos</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">{measurement.imageCount} imágenes</span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400">.epub original (ZIP)</div>
                <div className="mt-1 text-base font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                  {formatBytes(measurement.zipBytes)}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400">HTML capítulos</div>
                <div className="mt-1 text-base font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                  {formatBytes(measurement.chaptersRawHtmlBytes)}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400">Imágenes Base64</div>
                <div className="mt-1 text-base font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                  {formatBytes(measurement.inlineImagesBase64Bytes + measurement.coverDataUrlBytes)}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400">Bug footnotes [id]</div>
                <div className="mt-1 text-base font-semibold font-mono tabular-nums text-red-600 dark:text-red-400">
                  {formatBytes(measurement.luminaFootnotesBytes)}
                </div>
                <div className="text-xs font-mono tabular-nums text-slate-400">
                  {measurement.luminaFootnotesKeyCount} claves
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400">Total registro Lumina</div>
                <div className="mt-1 text-base font-semibold font-mono tabular-nums text-amber-600 dark:text-amber-400">
                  {formatBytes(measurement.luminaTotalRecordBytes)}
                </div>
                <div className="text-xs font-mono tabular-nums text-slate-400">
                  {measurement.inflationRatio}x vs .epub
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400">Total optimizado</div>
                <div className="mt-1 text-base font-semibold font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                  {formatBytes(measurement.optimizedRecordBytes)}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="py-6 border border-dashed border-slate-200 dark:border-slate-800 rounded-lg text-center space-y-1">
            <Layers className="w-5 h-5 text-slate-400 mx-auto" />
            <p className="text-xs text-slate-500 dark:text-slate-400">
              El análisis se ejecuta localmente en tu navegador sin subir archivos a ningún servidor.
            </p>
          </div>
        )}
      </div>

      {/* Estructura de los 5 Object Stores */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Esquema real de Object Stores en LuminaAppDB
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Cómo distribuye los datos y qué ocurre cuando entra en modo respaldo en memoria
            </p>
          </div>
          <Database className="w-4 h-4 text-slate-400 shrink-0" />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400 bg-slate-50/70 dark:bg-slate-950/50">
                <th className="py-3 px-6 font-medium">Store</th>
                <th className="py-3 px-4 font-medium">keyPath</th>
                <th className="py-3 px-4 font-medium">Contenido guardado</th>
                <th className="py-3 px-4 font-medium">Fallback RAM</th>
                <th className="py-3 px-6 font-medium">Observación crítica</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
              {STORAGE_STORES.map((row) => (
                <tr key={row.store} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                  <td className="py-3.5 px-6 font-mono font-semibold text-slate-900 dark:text-slate-100 whitespace-nowrap">
                    {row.store}
                  </td>
                  <td className="py-3.5 px-4 font-mono text-slate-600 dark:text-slate-300 whitespace-nowrap">
                    {row.keyPath}
                  </td>
                  <td className="py-3.5 px-4 text-slate-600 dark:text-slate-300 leading-relaxed">
                    {row.payload}
                  </td>
                  <td className="py-3.5 px-4 whitespace-nowrap">
                    <span
                      className={`font-semibold ${
                        row.memoryFallbackStatus === 'Con fallo'
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-emerald-700 dark:text-emerald-400'
                      }`}
                    >
                      {row.memoryFallbackStatus}
                    </span>
                  </td>
                  <td className="py-3.5 px-6 text-slate-600 dark:text-slate-300 leading-relaxed">
                    {row.notes}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
