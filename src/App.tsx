import { useEffect, useRef, useState } from 'react';
import { OfflineIndicator } from './components/OfflineIndicator';
import { PWAInstallButton } from './components/PWAInstallButton';
import { usePWAInstall } from './hooks/usePWAInstall';
import { swUpdateCoordinator } from './swUpdateCoordinator';

export default function App() {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  useEffect(() => {
    swUpdateCoordinator.setIframeElement(iframeRef.current);

    const syncPwaState = () => {
      try {
        iframeRef.current?.contentWindow?.postMessage(
          {
            type: 'NYXEN_PWA_STATE',
            isInstallable,
            isInstalled,
            isIOS,
          },
          window.location.origin
        );
      } catch {
        // Ignore if iframe is not ready
      }
    };

    syncPwaState();

    const handleMessage = async (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;

      if (typeof data.type === 'string' && data.type.startsWith('NYXEN_SW_')) {
        swUpdateCoordinator.handleWindowMessage(event);
        return;
      }

      if (data.type === 'NYXEN_REQUEST_PWA_STATE') {
        syncPwaState();
      } else if (data.type === 'NYXEN_REQUEST_PWA_INSTALL') {
        if (isInstallable) {
          await install();
        } else if (isIOS) {
          setShowIOSGuide(true);
        }
      } else if (data.type === 'NYXEN_THEME_COLOR' && typeof data.color === 'string') {
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) {
          meta.setAttribute('content', data.color);
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => {
      window.removeEventListener('message', handleMessage);
      swUpdateCoordinator.setIframeElement(null);
    };
  }, [isInstallable, isInstalled, isIOS, install]);

  return (
    <main className="w-screen h-[100dvh] overflow-hidden bg-[#121212]">
      <iframe
        ref={iframeRef}
        src="/Nyxen_EPUB_Reader.html?v=2.77.0"
        title="Nyxen - EPUB Reader"
        allow="fullscreen"
        onLoad={() => {
          swUpdateCoordinator.setIframeElement(iframeRef.current);
          swUpdateCoordinator.notifyIframeLoad();
          try {
            iframeRef.current?.contentWindow?.postMessage(
              {
                type: 'NYXEN_PWA_STATE',
                isInstallable,
                isInstalled,
                isIOS,
              },
              window.location.origin
            );
          } catch {
            // Ignore
          }
        }}
        className="w-full h-full border-0 block"
      />
      <PWAInstallButton
        isInstallable={isInstallable}
        isInstalled={isInstalled}
        isIOS={isIOS}
        onInstall={install}
        showIOSGuide={showIOSGuide}
        onShowIOSGuideChange={setShowIOSGuide}
      />
      <OfflineIndicator />
    </main>
  );
}
