import { useEffect, useRef, useState } from 'react';
import { OfflineIndicator } from './components/OfflineIndicator';
import { PWAInstallButton } from './components/PWAInstallButton';
import { usePWAInstall } from './hooks/usePWAInstall';
import { swUpdateCoordinator } from './swUpdateCoordinator';

export default function App() {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  const showIOSGuideRef = useRef(false);
  const iframeNavDepthRef = useRef(0);
  const pendingPopSyncRef = useRef(false);
  const pendingPopTargetDepthRef = useRef<number | null>(null);
  const pendingPopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncHistoryRef = useRef<() => void>(() => {});

  useEffect(() => {
    const getHistoryDepth = (state: unknown): number => {
      if (state && typeof state === 'object' && (state as { __nyxenNav?: unknown }).__nyxenNav === true) {
        const d = (state as { depth?: unknown }).depth;
        return typeof d === 'number' && Number.isFinite(d) && d > 0 ? Math.floor(d) : 0;
      }
      return 0;
    };

    const clearPendingPopTimer = () => {
      if (pendingPopTimerRef.current !== null) {
        clearTimeout(pendingPopTimerRef.current);
        pendingPopTimerRef.current = null;
      }
    };

    const syncHistory = () => {
      if (pendingPopSyncRef.current) return;
      const desiredDepth = (showIOSGuideRef.current ? 1 : 0) + iframeNavDepthRef.current;
      const currentDepth = getHistoryDepth(window.history.state);

      if (desiredDepth === currentDepth) return;

      if (desiredDepth > currentDepth) {
        for (let d = currentDepth + 1; d <= desiredDepth; d++) {
          try {
            window.history.pushState({ __nyxenNav: true, depth: d }, '');
          } catch {
            break;
          }
        }
        return;
      }

      const delta = currentDepth - desiredDepth;
      pendingPopSyncRef.current = true;
      pendingPopTargetDepthRef.current = desiredDepth;
      clearPendingPopTimer();
      pendingPopTimerRef.current = setTimeout(() => {
        pendingPopSyncRef.current = false;
        pendingPopTargetDepthRef.current = null;
        pendingPopTimerRef.current = null;
        syncHistory();
      }, 400);

      try {
        window.history.go(-delta);
      } catch {
        clearPendingPopTimer();
        pendingPopSyncRef.current = false;
        pendingPopTargetDepthRef.current = null;
      }
    };

    syncHistoryRef.current = syncHistory;

    if (getHistoryDepth(window.history.state) > 0) {
      try {
        window.history.replaceState(null, '');
      } catch {
        // Ignore
      }
    }

    const handlePopState = (event: PopStateEvent) => {
      const landedDepth = getHistoryDepth(event.state);

      if (pendingPopSyncRef.current) {
        clearPendingPopTimer();
        pendingPopSyncRef.current = false;
        pendingPopTargetDepthRef.current = null;
        syncHistory();
        return;
      }

      if (showIOSGuideRef.current) {
        showIOSGuideRef.current = false;
        setShowIOSGuide(false);
        syncHistory();
        return;
      }

      if (iframeNavDepthRef.current > 0) {
        try {
          iframeRef.current?.contentWindow?.postMessage(
            { type: 'NYXEN_NAV_BACK' },
            window.location.origin
          );
        } catch {
          // Ignore
        }
        return;
      }

      if (landedDepth > 0) {
        syncHistory();
      }
    };

    const handleNavMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (iframeRef.current?.contentWindow && event.source !== iframeRef.current.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== 'object' || data.type !== 'NYXEN_NAV_DEPTH') return;
      const nextDepth = typeof data.depth === 'number' && Number.isFinite(data.depth) && data.depth > 0
        ? Math.floor(data.depth)
        : 0;
      iframeNavDepthRef.current = nextDepth;
      syncHistory();
    };

    window.addEventListener('popstate', handlePopState);
    window.addEventListener('message', handleNavMessage);

    return () => {
      clearPendingPopTimer();
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('message', handleNavMessage);
    };
  }, []);

  useEffect(() => {
    showIOSGuideRef.current = showIOSGuide;
    syncHistoryRef.current();
  }, [showIOSGuide]);

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
          iframeNavDepthRef.current = 0;
          syncHistoryRef.current();
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
