import React from 'react';
import { useOnlineStatus } from '../hooks/useOnlineStatus';

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-full bg-amber-500/95 px-3 py-1.5 text-[11px] font-semibold text-white shadow-lg backdrop-blur-sm pointer-events-none select-none">
      <span className="h-2 w-2 rounded-full bg-white animate-pulse" />
      <span>Modo sin conexión</span>
    </div>
  );
};
