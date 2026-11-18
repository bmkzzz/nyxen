import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';

if (import.meta.env.DEV) {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then((regs) => {
      if (regs.length === 0) return;
      Promise.all(regs.map((r) => r.unregister())).then(() => {
        if (typeof caches !== 'undefined') {
          caches.keys()
            .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
            .finally(() => window.location.reload());
        } else {
          window.location.reload();
        }
      });
    }).catch(() => {});
  }
} else {
  const hadController = Boolean('serviceWorker' in navigator && navigator.serviceWorker.controller);
  let reloadedForSw = false;
  if ('serviceWorker' in navigator && hadController) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloadedForSw) return;
      reloadedForSw = true;
      window.location.reload();
    });
  }
  registerSW({
    immediate: true,
  });
}

createRoot(document.getElementById('root')!).render(<App />);
