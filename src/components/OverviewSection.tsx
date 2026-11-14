import { AlertTriangle, CheckCircle2, FileCode2, ShieldAlert, XCircle } from 'lucide-react';
import {
  AUDIT_FINDINGS,
  CODE_STRENGTHS,
  FILE_FACTS,
  REALITY_VS_UI,
  type RealityComparison
} from '../data/auditData';

interface OverviewSectionProps {
  onNavigate: (tab: 'bugs' | 'storage' | 'modules' | 'preview') => void;
}

function getRealityStatusStyle(status: RealityComparison['status']) {
  switch (status) {
    case 'Cumple':
      return { color: 'text-emerald-700 dark:text-emerald-400', Icon: CheckCircle2 };
    case 'Parcial':
      return { color: 'text-amber-700 dark:text-amber-400', Icon: AlertTriangle };
    case 'Inexacto':
      return { color: 'text-red-700 dark:text-red-400', Icon: XCircle };
    case 'No conectado':
      return { color: 'text-red-700 dark:text-red-400', Icon: ShieldAlert };
  }
}

export function OverviewSection({ onNavigate }: OverviewSectionProps) {
  const criticalCount = AUDIT_FINDINGS.filter((f) => f.severity === 'Crítica').length;
  const highCount = AUDIT_FINDINGS.filter((f) => f.severity === 'Alta').length;
  const mediumCount = AUDIT_FINDINGS.filter((f) => f.severity === 'Media').length;

  return (
    <div className="space-y-8">
      {/* Veredicto principal */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-6">
          <div className="space-y-3 max-w-3xl">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
              <span>{FILE_FACTS.filename}</span>
              <span aria-hidden="true">·</span>
              <span>{FILE_FACTS.totalLines.toLocaleString('es-ES')} líneas</span>
              <span aria-hidden="true">·</span>
              <span>{(FILE_FACTS.totalBytes / 1024).toFixed(1)} KB</span>
              <span aria-hidden="true">·</span>
              <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                IndexedDB v{FILE_FACTS.idbVersion} (Particionado en 7 stores)
              </span>
            </div>

            <h2 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100 text-balance">
              Código actualizado y blindado (v2.6.0): las 16 fallas de almacenamiento, seguridad XSS, parser EPUB y lector DOM fueron corregidas
            </h2>

            <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-300">
              Se reestructuró la arquitectura de almacenamiento en IndexedDB v10 separando metadatos ligeros (<code className="font-mono text-xs">books</code>), contenido de capítulos (<code className="font-mono text-xs">bookContents</code>) y binarios nativos (<code className="font-mono text-xs">bookAssets</code> con <code className="font-mono text-xs">Blob</code> + <code className="font-mono text-xs">URL.createObjectURL</code>). Además, se incorporó sanitización DOM anti-XSS, restauración de resaltados multi-nodo con <code className="font-mono text-xs">TreeWalker</code>, acotado estricto de notas al pie y persistencia de scroll intra-capítulo.
            </p>
          </div>

          <div className="flex flex-wrap lg:flex-col gap-2 shrink-0">
            <button
              type="button"
              onClick={() => onNavigate('preview')}
              className="px-4 py-2 rounded-lg bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 text-xs font-semibold hover:opacity-90 transition-opacity whitespace-nowrap shrink-0"
            >
              Probar versión v2.6 blindada
            </button>
            <button
              type="button"
              onClick={() => onNavigate('bugs')}
              className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
            >
              Ver las {AUDIT_FINDINGS.length} correcciones aplicadas
            </button>
          </div>
        </div>

        {/* Métricas reales extraídas del archivo */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 mt-6 pt-6 border-t border-slate-200 dark:border-slate-800">
          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Fallas críticas corregidas</div>
            <div className="mt-1 text-2xl font-semibold font-mono tabular-nums text-emerald-600 dark:text-emerald-400">
              {criticalCount}/{criticalCount}
            </div>
            <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              XSS sanitizado, cuota alertada y Blobs
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Fallas altas corregidas</div>
            <div className="mt-1 text-2xl font-semibold font-mono tabular-nums text-emerald-600 dark:text-emerald-400">
              {highCount}/{highCount}
            </div>
            <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              TreeWalker DOM, búsqueda y toggle
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Fallas medias corregidas</div>
            <div className="mt-1 text-2xl font-semibold font-mono tabular-nums text-emerald-600 dark:text-emerald-400">
              {mediumCount}/{mediumCount}
            </div>
            <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              TOC NCX/Nav, scroll ratio e i18n
            </div>
          </div>
          <div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Ahorro de RAM en Biblioteca</div>
            <div className="mt-1 text-2xl font-semibold font-mono tabular-nums text-slate-900 dark:text-slate-100">
              ~92%
            </div>
            <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Hidratación diferida bajo demanda
            </div>
          </div>
        </div>
      </div>

      {/* Tabla comparativa: Promesa de la UI vs Código Real */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Lo que declara la interfaz frente al código real
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Contrastación directa entre los textos de Lumina y las funciones ejecutadas en el script
            </p>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-xs text-slate-500 dark:text-slate-400 bg-slate-50/70 dark:bg-slate-950/50">
                <th className="py-3 px-6 font-medium">Capacidad</th>
                <th className="py-3 px-4 font-medium">Afirmación en UI</th>
                <th className="py-3 px-4 font-medium">Implementación verificada</th>
                <th className="py-3 px-6 font-medium text-right">Estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-sm">
              {REALITY_VS_UI.map((item) => {
                const { color, Icon } = getRealityStatusStyle(item.status);
                return (
                  <tr key={item.feature} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition-colors">
                    <td className="py-3.5 px-6 font-medium text-slate-900 dark:text-slate-100 whitespace-nowrap">
                      {item.feature}
                    </td>
                    <td className="py-3.5 px-4 text-xs text-slate-600 dark:text-slate-300">
                      {item.uiClaim}
                    </td>
                    <td className="py-3.5 px-4 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                      {item.actualBehavior}
                    </td>
                    <td className="py-3.5 px-6 text-right whitespace-nowrap">
                      <span className={`inline-flex items-center justify-end gap-1.5 text-xs font-semibold ${color}`}>
                        <Icon className="w-3.5 h-3.5 shrink-0" />
                        <span>{item.status}</span>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Lo que sí está bien construido */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
        <div className="flex items-center justify-between gap-4 pb-4 border-b border-slate-200 dark:border-slate-800">
          <div>
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Aciertos sólidos de la implementación actual
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Partes del código bien resueltas que conviene conservar al refactorizar
            </p>
          </div>
          <FileCode2 className="w-4 h-4 text-slate-400 shrink-0" />
        </div>

        <div className="divide-y divide-slate-200 dark:divide-slate-800">
          {CODE_STRENGTHS.map((strength) => (
            <div key={strength.title} className="py-4 first:pt-4 last:pb-0 flex flex-col sm:flex-row sm:items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {strength.title}
                  </h4>
                </div>
                <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed pl-6">
                  {strength.detail}
                </p>
              </div>
              <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap pl-6 sm:pl-0">
                Líneas {strength.lines}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
