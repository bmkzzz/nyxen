import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { MODULE_ANALYSES, type ModuleAnalysis } from '../data/auditData';

function getVerdictBadge(verdict: ModuleAnalysis['verdict']) {
  switch (verdict) {
    case 'Sólido':
      return { cls: 'text-emerald-700 dark:text-emerald-400', Icon: CheckCircle2 };
    case 'Con fallos':
      return { cls: 'text-amber-700 dark:text-amber-400', Icon: AlertTriangle };
    case 'Incompleto':
      return { cls: 'text-red-700 dark:text-red-400', Icon: XCircle };
  }
}

export function ModulesSection() {
  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          Análisis de funcionamiento módulo por módulo
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-300 mt-1 leading-relaxed">
          Desglose de las 8 áreas funcionales de Lumina EPUB Reader: cómo opera el flujo interno en cada vista y en qué escenarios concretos funciona bien o presenta errores.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {MODULE_ANALYSES.map((mod) => {
          const { cls, Icon } = getVerdictBadge(mod.verdict);
          return (
            <div
              key={mod.id}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 flex flex-col justify-between space-y-5"
            >
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-4 pb-3 border-b border-slate-200 dark:border-slate-800">
                  <div>
                    <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                      {mod.name}
                    </h3>
                    <div className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400 mt-0.5">
                      Líneas {mod.lines}
                    </div>
                  </div>

                  <span className={`inline-flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap shrink-0 ${cls}`}>
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{mod.verdict}</span>
                  </span>
                </div>

                <div className="space-y-2">
                  <div className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                    Qué funciona bien
                  </div>
                  <ul className="space-y-1.5 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                    {mod.whatWorks.map((point) => (
                      <li key={point} className="flex items-start gap-2">
                        <span className="text-emerald-600 dark:text-emerald-400 mt-0.5" aria-hidden="true">•</span>
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="space-y-2 pt-2 border-t border-slate-100 dark:border-slate-800/80">
                  <div className="text-xs font-semibold text-red-700 dark:text-red-400">
                    Fallas o limitaciones
                  </div>
                  <ul className="space-y-1.5 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                    {mod.whatFails.map((point) => (
                      <li key={point} className="flex items-start gap-2">
                        <span className="text-red-500 mt-0.5" aria-hidden="true">•</span>
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
