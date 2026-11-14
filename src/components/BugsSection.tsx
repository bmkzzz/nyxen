import { useMemo, useState } from 'react';
import { AlertCircle, AlertTriangle, Check, Info, Search, ShieldAlert } from 'lucide-react';
import {
  AUDIT_FINDINGS,
  type AuditCategory,
  type AuditFinding,
  type Severity
} from '../data/auditData';

const SEVERITIES: Array<'Todas' | Severity> = ['Todas', 'Crítica', 'Alta', 'Media'];
const CATEGORIES: Array<'Todas' | AuditCategory> = [
  'Todas',
  'Almacenamiento',
  'Seguridad XSS',
  'Lector y DOM',
  'Parser EPUB',
  'UI y Eventos'
];

function getSeverityIndicator(severity: Severity) {
  switch (severity) {
    case 'Crítica':
      return { textClass: 'text-red-600 dark:text-red-400', Icon: ShieldAlert };
    case 'Alta':
      return { textClass: 'text-amber-600 dark:text-amber-400', Icon: AlertTriangle };
    case 'Media':
      return { textClass: 'text-slate-600 dark:text-slate-300', Icon: Info };
  }
}

export function BugsSection() {
  const [severityFilter, setSeverityFilter] = useState<'Todas' | Severity>('Todas');
  const [categoryFilter, setCategoryFilter] = useState<'Todas' | AuditCategory>('Todas');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string>(AUDIT_FINDINGS[0].id);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return AUDIT_FINDINGS.filter((item) => {
      if (severityFilter !== 'Todas' && item.severity !== severityFilter) return false;
      if (categoryFilter !== 'Todas' && item.category !== categoryFilter) return false;
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        item.summary.toLowerCase().includes(q) ||
        item.symbol.toLowerCase().includes(q) ||
        item.lines.toLowerCase().includes(q)
      );
    });
  }, [severityFilter, categoryFilter, query]);

  const activeFinding: AuditFinding | undefined =
    filtered.find((f) => f.id === selectedId) || filtered[0];

  return (
    <div className="space-y-6">
      {/* Barra de filtros y búsqueda */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar falla por función, línea o descripción..."
              className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-400"
            />
          </div>

          {/* Control segmentado por severidad */}
          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg overflow-x-auto">
            {SEVERITIES.map((sev) => {
              const active = severityFilter === sev;
              return (
                <button
                  key={sev}
                  type="button"
                  onClick={() => setSeverityFilter(sev)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    active
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                  }`}
                >
                  {sev}
                </button>
              );
            })}
          </div>
        </div>

        {/* Filtro por categoría */}
        <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-slate-200 dark:border-slate-800">
          <span className="text-xs text-slate-500 dark:text-slate-400 mr-2">Área:</span>
          {CATEGORIES.map((cat) => {
            const active = categoryFilter === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setCategoryFilter(cat)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                {cat}
              </button>
            );
          })}
          <span className="ml-auto text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
            {filtered.length} de {AUDIT_FINDINGS.length} hallazgos
          </span>
        </div>
      </div>

      {/* Estado vacío o inspector maestro-detalle */}
      {filtered.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-10 text-center space-y-3">
          <AlertCircle className="w-7 h-7 text-slate-400 mx-auto" />
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
            No hay hallazgos que coincidan con el filtro
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Prueba limpiando el texto de búsqueda o seleccionando todas las severidades.
          </p>
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setSeverityFilter('Todas');
              setCategoryFilter('Todas');
            }}
            className="px-4 py-2 text-xs font-semibold rounded-lg bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 whitespace-nowrap"
          >
            Restablecer filtros
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Lista de fallas */}
          <div className="lg:col-span-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl divide-y divide-slate-200 dark:divide-slate-800 overflow-hidden">
            {filtered.map((item) => {
              const isSelected = activeFinding?.id === item.id;
              const { textClass, Icon } = getSeverityIndicator(item.severity);
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  className={`w-full text-left p-4 transition-colors block ${
                    isSelected
                      ? 'bg-slate-100/90 dark:bg-slate-800/80'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-xs mb-1">
                    <span className={`inline-flex items-center gap-1.5 font-semibold ${textClass}`}>
                      <Icon className="w-3.5 h-3.5 shrink-0" />
                      <span>{item.severity}</span>
                    </span>
                    <span className="inline-flex items-center gap-1 font-mono tabular-nums text-emerald-600 dark:text-emerald-400 font-semibold">
                      <Check className="w-3 h-3 shrink-0" />
                      <span>Corregido</span>
                    </span>
                  </div>
                  <div className="text-sm font-medium text-slate-900 dark:text-slate-100 leading-snug">
                    {item.title}
                  </div>
                  <div className="mt-1.5 flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                    <span>{item.category}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono truncate">{item.symbol}</span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Detalle técnico del fallo seleccionado */}
          {activeFinding && (
            <div className="lg:col-span-7 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5 lg:sticky lg:top-20">
              <div className="space-y-2 pb-4 border-b border-slate-200 dark:border-slate-800">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {(() => {
                    const { textClass, Icon } = getSeverityIndicator(activeFinding.severity);
                    return (
                      <span className={`inline-flex items-center gap-1.5 font-semibold ${textClass}`}>
                        <Icon className="w-4 h-4" />
                        <span>Severidad {activeFinding.severity}</span>
                      </span>
                    );
                  })()}
                  <span className="text-slate-400" aria-hidden="true">·</span>
                  <span className="text-slate-600 dark:text-slate-300">{activeFinding.category}</span>
                  <span className="text-slate-400" aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1 font-semibold text-emerald-600 dark:text-emerald-400">
                    <Check className="w-3.5 h-3.5" />
                    <span>Blindado en v2.5.0</span>
                  </span>
                </div>

                <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                  {activeFinding.title}
                </h3>
                <div className="text-xs font-mono text-slate-500 dark:text-slate-400">
                  {activeFinding.symbol}
                </div>
              </div>

              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                  Diagnóstico original detectado en v2.4.0
                </h4>
                <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                  {activeFinding.summary}
                </p>
              </div>

              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                  Impacto que provocaba
                </h4>
                <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                  {activeFinding.impact}
                </p>
              </div>

              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                  Código anterior vulnerable (v2.4.0)
                </h4>
                <pre className="p-3.5 rounded-lg bg-slate-950 text-slate-100 text-xs font-mono overflow-x-auto leading-relaxed border border-slate-800">
                  <code>{activeFinding.codeSnippet}</code>
                </pre>
              </div>

              <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                  <Check className="w-4 h-4 shrink-0" />
                  <span>Implementación aplicada en v2.5.0 (Activa en el archivo)</span>
                </div>
                <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                  {activeFinding.fixSummary}
                </p>
                <pre className="p-3.5 rounded-lg bg-slate-900 text-emerald-200 text-xs font-mono overflow-x-auto leading-relaxed border border-slate-800">
                  <code>{activeFinding.fixSnippet}</code>
                </pre>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
