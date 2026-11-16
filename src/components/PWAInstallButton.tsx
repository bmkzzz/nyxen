import React, { useState } from 'react';
import { Download, Share, X } from 'lucide-react';

interface PWAInstallButtonProps {
  isInstallable: boolean;
  isInstalled: boolean;
  isIOS: boolean;
  onInstall: () => Promise<boolean>;
  showIOSGuide: boolean;
  onShowIOSGuideChange: (open: boolean) => void;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({
  isInstallable,
  isInstalled,
  isIOS,
  onInstall,
  showIOSGuide,
  onShowIOSGuideChange,
}) => {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem('nyxen_pwa_banner_dismissed') === '1';
    } catch {
      return false;
    }
  });

  const handleDismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem('nyxen_pwa_banner_dismissed', '1');
    } catch {
      // Ignore storage errors
    }
  };

  if (isInstalled) {
    return null;
  }

  return (
    <>
      {!dismissed && isInstallable && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-1 rounded-full bg-[#1e1e21]/95 border border-white/15 pl-3 pr-1.5 py-1.5 text-xs font-semibold text-white shadow-2xl backdrop-blur-md">
          <button
            type="button"
            onClick={onInstall}
            className="flex items-center gap-1.5 hover:opacity-90 active:scale-95 transition"
          >
            <Download className="w-3.5 h-3.5 text-[#9d4edd]" />
            <span>Instalar Nyxen</span>
          </button>
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Cerrar"
            className="p-1 rounded-full opacity-60 hover:opacity-100 transition"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {!dismissed && !isInstallable && isIOS && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-1 rounded-full bg-[#1e1e21]/95 border border-white/15 pl-3 pr-1.5 py-1.5 text-xs font-semibold text-white shadow-2xl backdrop-blur-md">
          <button
            type="button"
            onClick={() => onShowIOSGuideChange(true)}
            className="flex items-center gap-1.5 hover:opacity-90 active:scale-95 transition"
          >
            <Download className="w-3.5 h-3.5 text-[#9d4edd]" />
            <span>Instalar en iOS</span>
          </button>
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Cerrar"
            className="p-1 rounded-full opacity-60 hover:opacity-100 transition"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {showIOSGuide && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={() => onShowIOSGuideChange(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-[#1e1e21] border border-white/10 p-5 text-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#9d4edd]/20 text-[#b47cff]">
                <Share className="w-4 h-4" />
              </div>
              <h3 className="text-base font-bold">Instalar Nyxen en iPhone / iPad</h3>
            </div>
            <p className="mt-3 text-xs text-white/80 leading-relaxed">
              1. Pulsa el botón <strong>Compartir</strong> en la barra de Safari.
              <br />
              2. Desplázate y elige <strong>Agregar a inicio</strong> para usarla sin conexión como app independiente.
            </p>
            <button
              type="button"
              onClick={() => onShowIOSGuideChange(false)}
              className="mt-4 w-full rounded-xl bg-[#9d4edd] py-2 text-xs font-bold text-white active:scale-95 transition"
            >
              Entendido
            </button>
          </div>
        </div>
      )}
    </>
  );
};
