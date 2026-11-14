import React, { useState } from 'react';
import { Download, X } from 'lucide-react';

interface PWAInstallButtonProps {
  isInstallable: boolean;
  isInstalled: boolean;
  isIOS: boolean;
  onInstall: () => Promise<boolean>;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({
  isInstallable,
  isInstalled,
  isIOS,
  onInstall,
}) => {
  const [dismissed, setDismissed] = useState(false);
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled || dismissed) {
    return null;
  }

  if (isInstallable) {
    return (
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
          onClick={() => setDismissed(true)}
          aria-label="Cerrar"
          className="p-1 rounded-full opacity-60 hover:opacity-100 transition"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  if (isIOS) {
    return (
      <>
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-1 rounded-full bg-[#1e1e21]/95 border border-white/15 pl-3 pr-1.5 py-1.5 text-xs font-semibold text-white shadow-2xl backdrop-blur-md">
          <button
            type="button"
            onClick={() => setShowIOSGuide(true)}
            className="flex items-center gap-1.5 hover:opacity-90 active:scale-95 transition"
          >
            <Download className="w-3.5 h-3.5 text-[#9d4edd]" />
            <span>Instalar en iOS</span>
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="Cerrar"
            className="p-1 rounded-full opacity-60 hover:opacity-100 transition"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
            <div className="w-full max-w-sm rounded-2xl bg-[#1e1e21] border border-white/10 p-5 text-white shadow-2xl">
              <h3 className="text-base font-bold">Instalar Nyxen en iPhone / iPad</h3>
              <p className="mt-2 text-xs text-white/75 leading-relaxed">
                1. Pulsa el botón <strong>Compartir</strong> en la barra de Safari.
                <br />
                2. Desplázate y elige <strong>Agregar a inicio</strong>.
              </p>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="mt-4 w-full rounded-xl bg-[#9d4edd] py-2 text-xs font-bold text-white active:scale-95 transition"
              >
                Cerrar
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
