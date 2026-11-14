import { useState } from 'react';
import { Download, Monitor, RotateCw, Smartphone } from 'lucide-react';
import { REPRODUCIBLE_CHECKS } from '../data/auditData';

const LUMINA_LOCAL_ASSET_PATH = '/assets/aistudio/Lumina_EPUB_Reader__3__7749e604.html';

export function PreviewSection() {
  const [viewportMode, setViewportMode] = useState<'mobile' | 'wide'>('mobile');
  const [reloadNonce, setReloadNonce] = useState(0);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
      {/* Marco interactivo con el HTML blindado */}
      <div className="xl:col-span-8 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Ejecución en vivo de Lumina EPUB Reader v2.6.0 (Blindado)
            </h2>
            <div className="text-xs font-mono text-slate-500 dark:text-slate-400">
              {LUMINA_LOCAL_ASSET_PATH}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
              <button
                type="button"
                onClick={() => setViewportMode('mobile')}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  viewportMode === 'mobile'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                <Smartphone className="w-3.5 h-3.5" />
                <span>Móvil (420px)</span>
              </button>
              <button
                type="button"
                onClick={() => setViewportMode('wide')}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  viewportMode === 'wide'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                <Monitor className="w-3.5 h-3.5" />
                <span>Ancho completo</span>
              </button>
            </div>

            <button
              type="button"
              onClick={() => setReloadNonce((n) => n + 1)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              <RotateCw className="w-3.5 h-3.5" />
              <span>Recargar app</span>
            </button>

            <a
              href={LUMINA_LOCAL_ASSET_PATH}
              download="Lumina_EPUB_Reader_v2.6_Blindado.html"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white transition-colors whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Descargar HTML</span>
            </a>
          </div>
        </div>

        <div className="p-4 sm:p-6 bg-slate-100 dark:bg-slate-950 flex justify-center">
          <iframe
            key={reloadNonce}
            src={`${LUMINA_LOCAL_ASSET_PATH}?v=2.31.${reloadNonce}`}
            title="Vista previa en vivo de Lumina EPUB Reader v2.6.0"
            className={`bg-black rounded-2xl border border-slate-300 dark:border-slate-800 shadow-sm transition-all ${
              viewportMode === 'mobile' ? 'w-full max-w-[420px] h-[780px]' : 'w-full h-[780px]'
            }`}
          />
        </div>
      </div>

      {/* Guía de pruebas rápidas para comprobar las mejoras */}
      <div className="xl:col-span-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5">
        <div className="pb-3 border-b border-slate-200 dark:border-slate-800">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Pruebas de verificación en vivo (v2.6.0)
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Pasos concretos para comprobar las optimizaciones aplicadas directamente en el iframe izquierdo
          </p>
        </div>

        <div className="divide-y divide-slate-200 dark:divide-slate-800">
          {REPRODUCIBLE_CHECKS.map((chk, index) => (
            <div key={chk.id} className="py-4 first:pt-0 last:pb-0 space-y-1.5">
              <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                0{index + 1}. {chk.title}
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                {chk.steps}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
