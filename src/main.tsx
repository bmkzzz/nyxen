import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';
import { swUpdateCoordinator } from './swUpdateCoordinator';

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
  swUpdateCoordinator.start(() => {
    registerSW({
      immediate: true,
      onNeedRefresh() {
        swUpdateCoordinator.notifyWaitingUpdate();
      },
      onNeedReload() {
        // Reload gestionado exclusivamente por swUpdateCoordinator tras commit en IndexedDB y controlador activado.
      },
      onRegisteredSW(_swUrl, registration) {
        swUpdateCoordinator.attachRegistration(registration);
      },
      onRegisterError(err) {
        swUpdateCoordinator.handleRegistrationError(err);
      },
    });
  });
}

createRoot(document.getElementById('root')!).render(<App />);
