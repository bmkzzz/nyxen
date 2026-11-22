export type SwParentState =
  | 'IDLE'
  | 'WAITING_UPDATE'
  | 'PREPARING'
  | 'COMMITTING_RELOAD'
  | 'DISPATCH_PENDING'
  | 'ACTIVATING_IRREVERSIBLE'
  | 'STALLED_ACTIVATION_RECOVERY'
  | 'RELOADING';

export type SwIframeState =
  | 'IDLE'
  | 'DRAINING'
  | 'ARMED'
  | 'COMMITTED_PRE_SKIP'
  | 'COMMITTED_DISPATCH_PENDING'
  | 'COMMITTED_IRREVERSIBLE'
  | 'RECOVERY_PROTECTED';

export interface SwWorkerLike {
  state: ServiceWorkerState | string;
  postMessage: (message: unknown) => void;
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
}

export interface SwRegistrationLike {
  installing?: SwWorkerLike | null;
  waiting?: SwWorkerLike | null;
  active?: SwWorkerLike | null;
  addEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
  update?: () => Promise<unknown>;
}

export interface SwMessageTargetLike {
  postMessage: (message: unknown, targetOrigin: string) => void;
}

export interface SwIframeLike {
  contentWindow: SwMessageTargetLike | null;
}

export interface AbortProof {
  waitingPresent: boolean;
  waitingState?: string | null;
  waitingStillAttached?: boolean;
  activeMatchesInitial: boolean;
  controllerMatchesInitial: boolean;
}

export interface CoordinatorSnapshot {
  state: SwParentState;
  token: string | null;
  seq: number;
  activationIrreversible: boolean;
  iframeReady: boolean;
  iframeSafeWindow: boolean;
  iframeState: SwIframeState | null;
  reloadCountInWindow: number;
  reloadLoopBlocked: boolean;
  legacyCacheCleaned: boolean;
  lastError: string | null;
}

export interface SwUpdateCoordinatorDeps {
  origin: string;
  getController: () => SwWorkerLike | null;
  addServiceWorkerListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeServiceWorkerListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
  reload: () => void;
  now: () => number;
  setTimeoutFn: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn: (id: ReturnType<typeof setTimeout>) => void;
  getSessionStorage: () => Storage | null;
  getCaches: () => CacheStorage | null;
  onStateChange?: (snapshot: CoordinatorSnapshot) => void;
}

interface ActiveCycle {
  token: string;
  seq: number;
  lastReceivedSeq: number;
  initialController: SwWorkerLike | null;
  initialWaiting: SwWorkerLike | null;
  waitingSw: SwWorkerLike | null;
  externalControllerChange: boolean;
  activationIrreversible: boolean;
  expectedEpoch: number | null;
  prepareTimer: ReturnType<typeof setTimeout> | null;
  commitTimer: ReturnType<typeof setTimeout> | null;
  stallTimer: ReturnType<typeof setTimeout> | null;
  waitingListenerCleanup: (() => void) | null;
  controllerListenerCleanup: (() => void) | null;
}

const RELOAD_GUARD_KEY = 'nyxen_sw_reload_guard_v1';
const RELOAD_GUARD_WINDOW_MS = 15_000;
const RELOAD_GUARD_MAX = 2;

const PREPARE_TIMEOUT_MS = 1500;
const COMMIT_TIMEOUT_MS = 1200;
const ACTIVATION_STALL_TIMEOUT_MS = 5000;
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 10_000;
const LEGACY_READER_CACHE_NAME = 'nyxen-reader-html-cache';

export function createBrowserDeps(): SwUpdateCoordinatorDeps {
  const swContainer = typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? navigator.serviceWorker : null;
  return {
    origin: typeof window !== 'undefined' ? window.location.origin : '',
    getController: () => (swContainer ? (swContainer.controller as unknown as SwWorkerLike | null) : null),
    addServiceWorkerListener: swContainer
      ? (type, listener) => swContainer.addEventListener(type, listener as EventListener)
      : undefined,
    removeServiceWorkerListener: swContainer
      ? (type, listener) => swContainer.removeEventListener(type, listener as EventListener)
      : undefined,
    reload: () => {
      if (typeof window !== 'undefined') {
        window.location.reload();
      }
    },
    now: () => Date.now(),
    setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
    clearTimeoutFn: (id) => clearTimeout(id),
    getSessionStorage: () => {
      try {
        return typeof window !== 'undefined' ? window.sessionStorage : null;
      } catch {
        return null;
      }
    },
    getCaches: () => {
      try {
        return typeof caches !== 'undefined' ? caches : null;
      } catch {
        return null;
      }
    },
  };
}

export class SwUpdateCoordinator {
  private deps: SwUpdateCoordinatorDeps;
  private state: SwParentState = 'IDLE';
  private registration: SwRegistrationLike | null = null;
  private iframeEl: SwIframeLike | null = null;
  private activeCycle: ActiveCycle | null = null;
  private tokenCounter = 0;
  private started = false;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  private iframeReady = false;
  private iframeSafeWindow = false;
  private iframeState: SwIframeState | null = null;
  private lastError: string | null = null;
  private reloadLoopBlocked = false;
  private legacyCacheCleaned = false;
  private knownInitialController: SwWorkerLike | null = null;

  private regUpdateFoundCleanup: (() => void) | null = null;
  private swControllerChangeListener: EventListener | null = null;

  constructor(deps: SwUpdateCoordinatorDeps) {
    this.deps = deps;
    this.knownInitialController = deps.getController();
  }

  start(registerFn?: () => void): void {
    if (this.started) return;
    this.started = true;
    this.knownInitialController = this.deps.getController();

    if (this.deps.addServiceWorkerListener) {
      this.swControllerChangeListener = () => {
        this.handleControllerChange();
      };
      this.deps.addServiceWorkerListener('controllerchange', this.swControllerChangeListener);
    }

    if (typeof registerFn === 'function') {
      try {
        registerFn();
      } catch (err) {
        this.handleRegistrationError(err);
      }
    }
  }

  destroy(): void {
    this.clearRetryTimer();
    this.clearCycleTimers(this.activeCycle);
    this.activeCycle?.waitingListenerCleanup?.();
    this.activeCycle?.controllerListenerCleanup?.();
    this.regUpdateFoundCleanup?.();
    this.regUpdateFoundCleanup = null;
    if (this.swControllerChangeListener && this.deps.removeServiceWorkerListener) {
      this.deps.removeServiceWorkerListener('controllerchange', this.swControllerChangeListener);
    }
    this.swControllerChangeListener = null;
    this.started = false;
  }

  setIframeElement(el: SwIframeLike | null): void {
    this.iframeEl = el;
    if (!el) {
      this.iframeReady = false;
    }
  }

  notifyIframeLoad(): void {
    this.iframeReady = false;
    this.iframeSafeWindow = false;
    this.iframeState = null;
    this.emitSnapshot();
  }

  getSnapshot(): CoordinatorSnapshot {
    const active = this.activeCycle;
    return {
      state: this.state,
      token: active ? active.token : null,
      seq: active ? active.seq : 0,
      activationIrreversible: Boolean(active?.activationIrreversible),
      iframeReady: this.iframeReady,
      iframeSafeWindow: this.iframeSafeWindow,
      iframeState: this.iframeState,
      reloadCountInWindow: this.readReloadTimestampsInWindow().length,
      reloadLoopBlocked: this.reloadLoopBlocked,
      legacyCacheCleaned: this.legacyCacheCleaned,
      lastError: this.lastError,
    };
  }

  attachRegistration(reg: SwRegistrationLike | null | undefined): void {
    if (!reg) return;
    this.regUpdateFoundCleanup?.();
    this.regUpdateFoundCleanup = null;
    this.registration = reg;

    if (reg.addEventListener) {
      const onUpdateFound = () => {
        const inst = reg.installing;
        if (!inst) return;
        const onInstStateChange = () => {
          if (inst.state === 'installed' && this.deps.getController()) {
            this.notifyWaitingUpdate();
          }
        };
        inst.addEventListener('statechange', onInstStateChange);
      };
      reg.addEventListener('updatefound', onUpdateFound);
      this.regUpdateFoundCleanup = () => {
        reg.removeEventListener?.('updatefound', onUpdateFound);
      };
    }

    // Cubre el hueco de workbox-window cuando wasWaitingBeforeRegister === true
    if (reg.waiting && this.deps.getController()) {
      this.notifyWaitingUpdate();
    } else {
      void this.cleanupLegacyReaderHtmlCacheIfSafe();
    }
  }

  handleRegistrationError(err: unknown): void {
    this.lastError = err instanceof Error ? err.message : String(err ?? 'sw-register-error');
    this.emitSnapshot();
  }

  notifyWaitingUpdate(): void {
    if (
      this.state === 'ACTIVATING_IRREVERSIBLE' ||
      this.state === 'STALLED_ACTIVATION_RECOVERY' ||
      this.state === 'RELOADING' ||
      this.state === 'DISPATCH_PENDING' ||
      this.state === 'COMMITTING_RELOAD' ||
      this.state === 'PREPARING'
    ) {
      return;
    }

    if (!this.registration?.waiting || !this.deps.getController()) {
      return;
    }

    this.setState('WAITING_UPDATE');
    this.tryInitiatePrepare();
  }

  handleWindowMessage(event: Pick<MessageEvent, 'origin' | 'source' | 'data'>): void {
    if (!event || event.origin !== this.deps.origin) return;
    if (this.iframeEl?.contentWindow && event.source !== (this.iframeEl.contentWindow as unknown)) {
      return;
    }

    const data = event.data as Record<string, unknown> | null | undefined;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
    if (!data.type.startsWith('NYXEN_SW_')) return;

    switch (data.type) {
      case 'NYXEN_SW_HELLO': {
        this.iframeReady = data.ready !== false;
        if (typeof data.safeWindow === 'boolean') {
          this.iframeSafeWindow = data.safeWindow;
        }
        if (typeof data.lockState === 'string') {
          this.iframeState = data.lockState as SwIframeState;
        }
        this.emitSnapshot();
        if (this.iframeReady) {
          if (this.state === 'WAITING_UPDATE' && this.iframeSafeWindow) {
            this.tryInitiatePrepare();
          } else if (this.state === 'IDLE' && this.registration?.waiting && this.deps.getController()) {
            this.notifyWaitingUpdate();
          }
          void this.cleanupLegacyReaderHtmlCacheIfSafe();
        }
        break;
      }

      case 'NYXEN_SW_SAFE_WINDOW_STATUS': {
        if (typeof data.safeWindow === 'boolean') {
          this.iframeSafeWindow = data.safeWindow;
        }
        this.emitSnapshot();
        if (this.state === 'WAITING_UPDATE' && this.iframeSafeWindow) {
          this.tryInitiatePrepare();
        } else if (this.state === 'IDLE' && this.iframeSafeWindow && this.registration?.waiting && this.deps.getController()) {
          this.notifyWaitingUpdate();
        }
        break;
      }

      case 'NYXEN_SW_PREPARE_ACK': {
        this.handlePrepareAck(data);
        break;
      }

      case 'NYXEN_SW_PREPARE_BUSY':
      case 'NYXEN_SW_PREPARE_INVALIDATED': {
        this.handlePrepareRejected(data, String(data.reason || data.type));
        break;
      }

      case 'NYXEN_SW_COMMIT_CONFIRMED': {
        this.handleCommitConfirmed(data);
        break;
      }

      case 'NYXEN_SW_COMMIT_REJECTED': {
        this.handleCommitRejected(data);
        break;
      }

      case 'NYXEN_SW_STATUS_REPORT': {
        this.handleStatusReport(data);
        break;
      }

      case 'NYXEN_SW_IFRAME_INIT_ERROR': {
        this.lastError = String(data.error || 'iframe-init-error');
        this.emitSnapshot();
        if (
          this.state === 'ACTIVATING_IRREVERSIBLE' ||
          this.state === 'STALLED_ACTIVATION_RECOVERY'
        ) {
          this.checkControllerTransition();
        }
        break;
      }

      case 'NYXEN_SW_EMERGENCY_RECOVER': {
        this.handleEmergencyRecover(data);
        break;
      }

      default:
        break;
    }
  }

  handleControllerChange(): void {
    const currentCtrl = this.deps.getController();
    const active = this.activeCycle;

    if (
      this.state === 'ACTIVATING_IRREVERSIBLE' ||
      this.state === 'STALLED_ACTIVATION_RECOVERY' ||
      this.state === 'RELOADING'
    ) {
      this.checkControllerTransition();
      return;
    }

    const baselineCtrl = active?.initialController ?? this.knownInitialController;
    if (!baselineCtrl) {
      // Primer registro (install inicial con clientsClaim): no recargar
      this.knownInitialController = currentCtrl;
      void this.cleanupLegacyReaderHtmlCacheIfSafe();
      return;
    }

    if (!currentCtrl || currentCtrl === baselineCtrl) {
      return;
    }

    // controllerchange externo (ej. otra pestaña llamó skipWaiting)
    if (this.state === 'DISPATCH_PENDING' && active) {
      this.enterActivatingIrreversible(active, 'external-controllerchange-during-dispatch');
      return;
    }

    this.triggerExternalControllerChangeDrain(currentCtrl, baselineCtrl);
  }

  private triggerExternalControllerChangeDrain(
    newController: SwWorkerLike,
    previousController: SwWorkerLike
  ): void {
    this.clearRetryTimer();
    if (this.activeCycle) {
      this.clearCycleTimers(this.activeCycle);
      this.activeCycle.waitingListenerCleanup?.();
      this.activeCycle.controllerListenerCleanup?.();
    }

    if (!this.iframeEl?.contentWindow || !this.iframeReady) {
      // Iframe aún no montado o sin puente vivo: esperar activación real del controlador y recargar con guarda anti-bucle
      const cycle = this.createCycle(previousController, newController, true);
      this.activeCycle = cycle;
      this.enterActivatingIrreversible(cycle, 'external-controllerchange-no-iframe');
      return;
    }

    const cycle = this.createCycle(previousController, newController, true);
    this.activeCycle = cycle;
    this.setState('PREPARING');

    const sentSeq = this.nextSeq(cycle);
    this.postToIframe({
      type: 'NYXEN_SW_PREPARE_UPDATE',
      token: cycle.token,
      seq: sentSeq,
      externalControllerChange: true,
    });

    cycle.prepareTimer = this.deps.setTimeoutFn(() => {
      if (this.activeCycle !== cycle || this.state !== 'PREPARING') return;
      this.sendCancelAndRetry(cycle, 'external-prepare-timeout');
    }, PREPARE_TIMEOUT_MS);
  }

  private tryInitiatePrepare(): void {
    if (this.state !== 'WAITING_UPDATE') return;
    const reg = this.registration;
    if (!reg?.waiting) {
      this.setState('IDLE');
      return;
    }
    if (!this.iframeEl?.contentWindow || !this.iframeReady) {
      return;
    }
    if (!this.iframeSafeWindow) {
      return;
    }

    this.clearRetryTimer();
    const initialCtrl = this.deps.getController();
    const initialWaiting = reg.waiting;
    const cycle = this.createCycle(initialCtrl, initialWaiting, false);
    this.activeCycle = cycle;
    this.setState('PREPARING');

    const sentSeq = this.nextSeq(cycle);
    this.postToIframe({
      type: 'NYXEN_SW_PREPARE_UPDATE',
      token: cycle.token,
      seq: sentSeq,
      externalControllerChange: false,
    });

    cycle.prepareTimer = this.deps.setTimeoutFn(() => {
      if (this.activeCycle !== cycle || this.state !== 'PREPARING') return;
      this.sendCancelAndRetry(cycle, 'prepare-timeout');
    }, PREPARE_TIMEOUT_MS);
  }

  private handlePrepareAck(data: Record<string, unknown>): void {
    const cycle = this.activeCycle;
    if (!cycle || this.state !== 'PREPARING') return;
    if (data.token !== cycle.token) return;
    if (typeof data.seq !== 'number' || data.seq <= cycle.lastReceivedSeq) return;
    if (typeof data.epoch !== 'number' || !Number.isFinite(data.epoch)) return;

    cycle.lastReceivedSeq = data.seq;
    if (cycle.prepareTimer) {
      this.deps.clearTimeoutFn(cycle.prepareTimer);
      cycle.prepareTimer = null;
    }

    if (!cycle.externalControllerChange && data.safeWindow === false) {
      this.sendCancelAndRetry(cycle, 'unsafe-window-on-ack');
      return;
    }

    cycle.expectedEpoch = data.epoch;
    this.setState('COMMITTING_RELOAD');

    const commitSeq = this.nextSeq(cycle);
    this.postToIframe({
      type: 'NYXEN_SW_COMMIT_CHECK',
      token: cycle.token,
      seq: commitSeq,
      expectedEpoch: data.epoch,
      externalControllerChange: cycle.externalControllerChange,
    });

    cycle.commitTimer = this.deps.setTimeoutFn(() => {
      if (this.activeCycle !== cycle || this.state !== 'COMMITTING_RELOAD') return;
      this.sendCancelAndRetry(cycle, 'commit-check-timeout');
    }, COMMIT_TIMEOUT_MS);
  }

  private handlePrepareRejected(data: Record<string, unknown>, reason: string): void {
    const cycle = this.activeCycle;
    if (!cycle) return;
    if (data.token !== cycle.token) return;
    if (typeof data.seq === 'number' && data.seq <= cycle.lastReceivedSeq) return;
    if (typeof data.seq === 'number') cycle.lastReceivedSeq = data.seq;

    if (this.state !== 'PREPARING' && this.state !== 'COMMITTING_RELOAD') return;
    this.sendCancelAndRetry(cycle, reason);
  }

  private handleCommitRejected(data: Record<string, unknown>): void {
    const cycle = this.activeCycle;
    if (!cycle || this.state !== 'COMMITTING_RELOAD') return;
    if (data.token !== cycle.token) return;
    if (typeof data.seq === 'number' && data.seq <= cycle.lastReceivedSeq) return;
    if (typeof data.seq === 'number') cycle.lastReceivedSeq = data.seq;

    this.sendCancelAndRetry(cycle, String(data.reason || 'commit-rejected'));
  }

  private handleCommitConfirmed(data: Record<string, unknown>): void {
    const cycle = this.activeCycle;
    if (!cycle || this.state !== 'COMMITTING_RELOAD') return;
    if (data.token !== cycle.token) return;
    if (typeof data.seq !== 'number' || data.seq <= cycle.lastReceivedSeq) return;

    cycle.lastReceivedSeq = data.seq;
    if (cycle.commitTimer) {
      this.deps.clearTimeoutFn(cycle.commitTimer);
      cycle.commitTimer = null;
    }

    // Secuencia estricta de frontera irreversible:
    // 1. Transicionar a DISPATCH_PENDING y notificar al iframe (bloqueado, aún abortable con prueba)
    this.setState('DISPATCH_PENDING');
    const dispatchSeq = this.nextSeq(cycle);
    this.postToIframe({
      type: 'NYXEN_SW_DISPATCH_PENDING',
      token: cycle.token,
      seq: dispatchSeq,
    });

    if (cycle.externalControllerChange) {
      this.enterActivatingIrreversible(cycle, 'external-controllerchange-committed');
      return;
    }

    const regRef = this.registration;
    const ctrlNow = this.deps.getController();
    const initialCtrl = cycle.initialController;
    const initialWaiting = cycle.initialWaiting;
    const waitingSw = regRef?.waiting || null;

    if (!waitingSw) {
      const controllerChanged = ctrlNow !== initialCtrl;
      const foreignActive = Boolean(regRef?.active && regRef.active !== initialCtrl);
      const installingActivating = Boolean(regRef?.installing && regRef.installing.state === 'activating');

      if (
        !controllerChanged &&
        !foreignActive &&
        !installingActivating &&
        regRef &&
        regRef.active === initialCtrl &&
        initialWaiting &&
        initialWaiting.state === 'redundant'
      ) {
        // El waiting inicial pasó a redundant sin activarse mientras active y controller siguen siendo el inicial
        this.abortBeforeDispatch(cycle, 'waiting-redundant-before-dispatch', {
          waitingPresent: false,
          waitingState: 'redundant',
          waitingStillAttached: false,
          activeMatchesInitial: true,
          controllerMatchesInitial: true,
        });
        return;
      }

      // Resultado ambiguo o activación ya en curso
      this.enterActivatingIrreversible(cycle, 'waiting-disappeared-ambiguous');
      return;
    }

    if (
      !initialWaiting ||
      waitingSw !== initialWaiting ||
      waitingSw.state !== 'installed' ||
      !regRef ||
      regRef.active !== initialCtrl ||
      ctrlNow !== initialCtrl
    ) {
      // Worker sustituido, ya en activación/activado o desalineado con controlador/activo inicial -> irreversible
      this.enterActivatingIrreversible(
        cycle,
        waitingSw !== initialWaiting
          ? 'waiting-replaced-before-dispatch'
          : waitingSw.state !== 'installed'
            ? `waiting-already-${waitingSw.state}`
            : 'controller-or-active-mismatch-before-dispatch'
      );
      return;
    }

    // Adjuntar listener statechange directo sobre initialWaiting ANTES de postMessage
    this.attachWaitingStateListener(cycle, initialWaiting);

    try {
      waitingSw.postMessage({ type: 'SKIP_WAITING' });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err ?? 'skip-waiting-postmessage-error');
      const ctrlAfterThrow = this.deps.getController();
      const waitingStillInitial = Boolean(regRef && regRef.waiting === initialWaiting && waitingSw === initialWaiting);
      const stillInstalled = waitingSw.state === 'installed';
      const activeMatchesInitial = Boolean(regRef && regRef.active === initialCtrl);
      const controllerMatchesInitial = ctrlAfterThrow === initialCtrl;

      if (
        waitingStillInitial &&
        stillInstalled &&
        activeMatchesInitial &&
        controllerMatchesInitial &&
        !cycle.activationIrreversible
      ) {
        this.abortBeforeDispatch(cycle, 'postMessage-threw-waiting-intact', {
          waitingPresent: true,
          waitingState: waitingSw.state,
          waitingStillAttached: true,
          activeMatchesInitial: true,
          controllerMatchesInitial: true,
        });
      } else {
        this.enterActivatingIrreversible(cycle, 'postMessage-threw-ambiguous-state');
      }
      return;
    }

    // postMessage despachado sin excepción -> cruzar frontera irreversible
    this.enterActivatingIrreversible(cycle, 'skip-waiting-dispatched');
  }

  private abortBeforeDispatch(cycle: ActiveCycle, reason: string, proof: AbortProof): void {
    if (cycle.activationIrreversible) return;
    this.clearCycleTimers(cycle);
    cycle.waitingListenerCleanup?.();
    cycle.controllerListenerCleanup?.();

    const abortSeq = this.nextSeq(cycle);
    this.postToIframe({
      type: 'NYXEN_SW_ABORT_CONFIRMED',
      token: cycle.token,
      seq: abortSeq,
      skipWaitingDispatched: false,
      reason,
      proof,
    });

    this.activeCycle = null;
    if (this.registration?.waiting && this.deps.getController()) {
      this.setState('WAITING_UPDATE');
      this.scheduleRetry();
    } else {
      this.setState('IDLE');
    }
  }

  private enterActivatingIrreversible(cycle: ActiveCycle, _reason: string): void {
    cycle.activationIrreversible = true;
    this.clearRetryTimer();
    if (cycle.prepareTimer) {
      this.deps.clearTimeoutFn(cycle.prepareTimer);
      cycle.prepareTimer = null;
    }
    if (cycle.commitTimer) {
      this.deps.clearTimeoutFn(cycle.commitTimer);
      cycle.commitTimer = null;
    }

    const listenerSw = cycle.initialWaiting ?? cycle.waitingSw;
    if (listenerSw) {
      this.attachWaitingStateListener(cycle, listenerSw);
    }

    this.setState('ACTIVATING_IRREVERSIBLE');
    const irrevSeq = this.nextSeq(cycle);
    this.postToIframe({
      type: 'NYXEN_SW_ACTIVATION_IRREVERSIBLE',
      token: cycle.token,
      seq: irrevSeq,
    });

    if (!cycle.stallTimer) {
      cycle.stallTimer = this.deps.setTimeoutFn(() => {
        if (this.activeCycle !== cycle) return;
        if (this.state !== 'ACTIVATING_IRREVERSIBLE') return;
        this.checkControllerTransition();
        if (this.state === 'ACTIVATING_IRREVERSIBLE') {
          this.setState('STALLED_ACTIVATION_RECOVERY');
          void this.registration?.update?.().catch(() => {});
        }
      }, ACTIVATION_STALL_TIMEOUT_MS);
    }

    this.checkControllerTransition();
  }

  private attachWaitingStateListener(cycle: ActiveCycle, sw: SwWorkerLike): void {
    if (cycle.waitingListenerCleanup) return;
    const onStateChange = () => {
      if (this.activeCycle !== cycle) return;
      if (sw.state === 'activating' && this.state === 'DISPATCH_PENDING') {
        this.enterActivatingIrreversible(cycle, 'waiting-state-activating');
      } else if (sw.state === 'activated') {
        this.checkControllerTransition();
      }
    };
    sw.addEventListener('statechange', onStateChange);
    cycle.waitingListenerCleanup = () => {
      sw.removeEventListener?.('statechange', onStateChange);
      cycle.waitingListenerCleanup = null;
    };
  }

  private checkControllerTransition(): void {
    const cycle = this.activeCycle;
    if (!cycle) return;
    if (
      this.state !== 'ACTIVATING_IRREVERSIBLE' &&
      this.state !== 'STALLED_ACTIVATION_RECOVERY'
    ) {
      return;
    }

    const curCtrl = this.deps.getController();
    if (!curCtrl || curCtrl === cycle.initialController) {
      return;
    }

    if (curCtrl.state === 'activated') {
      this.triggerSafeReload(cycle);
      return;
    }

    // Si controllerchange ya cambió al nuevo SW pero aún está en 'activating', esperar 'activated'
    if (!cycle.controllerListenerCleanup) {
      const onCtrlStateChange = () => {
        if (this.activeCycle !== cycle) return;
        const latestCtrl = this.deps.getController();
        if (latestCtrl && latestCtrl !== cycle.initialController && latestCtrl.state === 'activated') {
          this.triggerSafeReload(cycle);
        }
      };
      curCtrl.addEventListener('statechange', onCtrlStateChange);
      cycle.controllerListenerCleanup = () => {
        curCtrl.removeEventListener?.('statechange', onCtrlStateChange);
        cycle.controllerListenerCleanup = null;
      };
    }
  }

  private triggerSafeReload(cycle: ActiveCycle): void {
    if (this.state === 'RELOADING') return;

    if (!this.recordAndCheckReloadBudget()) {
      this.reloadLoopBlocked = true;
      this.setState('STALLED_ACTIVATION_RECOVERY');
      return;
    }

    this.clearCycleTimers(cycle);
    cycle.waitingListenerCleanup?.();
    cycle.controllerListenerCleanup?.();
    this.setState('RELOADING');
    this.deps.reload();
  }

  private handleStatusReport(data: Record<string, unknown>): void {
    if (typeof data.state === 'string') {
      this.iframeState = data.state as SwIframeState;
    }
    if (typeof data.safeWindow === 'boolean') {
      this.iframeSafeWindow = data.safeWindow;
    }
    this.emitSnapshot();

    if (
      this.iframeState === 'RECOVERY_PROTECTED' &&
      (this.state === 'ACTIVATING_IRREVERSIBLE' || this.state === 'STALLED_ACTIVATION_RECOVERY')
    ) {
      this.checkControllerTransition();
    }
  }

  private handleEmergencyRecover(data: Record<string, unknown>): void {
    if (typeof data.state === 'string') {
      this.iframeState = data.state as SwIframeState;
    }
    this.lastError = String(data.reason || 'iframe-emergency-recover');
    this.emitSnapshot();

    if (
      this.state === 'ACTIVATING_IRREVERSIBLE' ||
      this.state === 'STALLED_ACTIVATION_RECOVERY'
    ) {
      this.checkControllerTransition();
      if ((this.state as SwParentState) !== 'RELOADING') {
        this.setState('STALLED_ACTIVATION_RECOVERY');
        void this.registration?.update?.().catch(() => {});
      }
      return;
    }

    // Si el padre no está en transición irreversible pero el controlador ya cambió externamente:
    const curCtrl = this.deps.getController();
    const baseCtrl = this.activeCycle?.initialController ?? this.knownInitialController;
    if (baseCtrl && curCtrl && curCtrl !== baseCtrl && curCtrl.state === 'activated') {
      const cycle = this.activeCycle ?? this.createCycle(baseCtrl, curCtrl, true);
      cycle.activationIrreversible = true;
      this.activeCycle = cycle;
      this.triggerSafeReload(cycle);
      return;
    }

    // Nunca recargar ni liberar a ciegas si el mismo controlador inicial sigue activo
    if (this.state === 'IDLE' || this.state === 'WAITING_UPDATE') {
      this.setState('STALLED_ACTIVATION_RECOVERY');
    }
  }

  private sendCancelAndRetry(cycle: ActiveCycle, reason: string): void {
    if (cycle.activationIrreversible) return;
    if (this.state === 'DISPATCH_PENDING') return;

    this.clearCycleTimers(cycle);
    cycle.waitingListenerCleanup?.();
    cycle.controllerListenerCleanup?.();

    const cancelSeq = this.nextSeq(cycle);
    this.postToIframe({
      type: 'NYXEN_SW_CANCEL_UPDATE',
      token: cycle.token,
      seq: cancelSeq,
      reason,
    });

    this.activeCycle = null;
    if (this.registration?.waiting && this.deps.getController()) {
      this.setState('WAITING_UPDATE');
      this.scheduleRetry();
    } else {
      this.setState('IDLE');
    }
  }

  private scheduleRetry(): void {
    this.clearRetryTimer();
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(1.5, this.retryCount));
    this.retryCount = Math.min(this.retryCount + 1, 6);
    this.retryTimer = this.deps.setTimeoutFn(() => {
      this.retryTimer = null;
      if (this.state === 'WAITING_UPDATE') {
        this.tryInitiatePrepare();
      }
    }, delay);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      this.deps.clearTimeoutFn(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private createCycle(
    initialController: SwWorkerLike | null,
    waitingSw: SwWorkerLike | null,
    externalControllerChange: boolean
  ): ActiveCycle {
    const token = `swupd_${++this.tokenCounter}_${this.deps.now().toString(36)}`;
    return {
      token,
      seq: 0,
      lastReceivedSeq: 0,
      initialController,
      initialWaiting: externalControllerChange ? null : waitingSw,
      waitingSw,
      externalControllerChange,
      activationIrreversible: false,
      expectedEpoch: null,
      prepareTimer: null,
      commitTimer: null,
      stallTimer: null,
      waitingListenerCleanup: null,
      controllerListenerCleanup: null,
    };
  }

  private nextSeq(cycle: ActiveCycle): number {
    cycle.seq += 1;
    return cycle.seq;
  }

  private postToIframe(payload: Record<string, unknown>): void {
    try {
      this.iframeEl?.contentWindow?.postMessage(payload, this.deps.origin);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err ?? 'postMessage-error');
    }
  }

  private clearCycleTimers(cycle: ActiveCycle | null): void {
    if (!cycle) return;
    if (cycle.prepareTimer) {
      this.deps.clearTimeoutFn(cycle.prepareTimer);
      cycle.prepareTimer = null;
    }
    if (cycle.commitTimer) {
      this.deps.clearTimeoutFn(cycle.commitTimer);
      cycle.commitTimer = null;
    }
    if (cycle.stallTimer) {
      this.deps.clearTimeoutFn(cycle.stallTimer);
      cycle.stallTimer = null;
    }
  }

  private setState(next: SwParentState): void {
    if (this.state === next) {
      this.emitSnapshot();
      return;
    }
    this.state = next;
    if (next === 'IDLE') {
      this.retryCount = 0;
    }
    this.emitSnapshot();
  }

  private emitSnapshot(): void {
    try {
      this.deps.onStateChange?.(this.getSnapshot());
    } catch {
      // Ignore observer errors
    }
  }

  private readReloadTimestampsInWindow(): number[] {
    const ss = this.deps.getSessionStorage();
    if (!ss) return [];
    const now = this.deps.now();
    try {
      const raw = ss.getItem(RELOAD_GUARD_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((ts): ts is number => typeof ts === 'number' && Number.isFinite(ts) && now - ts < RELOAD_GUARD_WINDOW_MS);
    } catch {
      return [];
    }
  }

  private recordAndCheckReloadBudget(): boolean {
    const ss = this.deps.getSessionStorage();
    if (!ss) return true;
    const now = this.deps.now();
    const recent = this.readReloadTimestampsInWindow();
    if (recent.length >= RELOAD_GUARD_MAX) {
      return false;
    }
    recent.push(now);
    try {
      ss.setItem(RELOAD_GUARD_KEY, JSON.stringify(recent));
    } catch {
      // Ignore storage write quota errors
    }
    return true;
  }

  async cleanupLegacyReaderHtmlCacheIfSafe(): Promise<boolean> {
    if (this.legacyCacheCleaned) return false;
    const cacheStorage = this.deps.getCaches();
    if (!cacheStorage) return false;

    const ctrl = this.deps.getController();
    if (!ctrl || ctrl.state !== 'activated') return false;
    if (this.registration?.waiting || this.registration?.installing) return false;
    if (!this.iframeReady) return false;
    if (this.state !== 'IDLE') return false;

    try {
      const hasLegacy = await cacheStorage.has(LEGACY_READER_CACHE_NAME);
      if (!hasLegacy) {
        this.legacyCacheCleaned = true;
        return false;
      }

      // Comprobar que el precache activo sirve /Nyxen_EPUB_Reader.html con HTTP 200 (fuera de nyxen-reader-html-cache)
      const cacheKeys = await cacheStorage.keys();
      let precachedOk = false;
      for (const name of cacheKeys) {
        if (name === LEGACY_READER_CACHE_NAME) continue;
        const c = await cacheStorage.open(name);
        const match = await c.match('/Nyxen_EPUB_Reader.html', { ignoreSearch: true });
        if (match && match.status === 200) {
          precachedOk = true;
          break;
        }
      }
      if (!precachedOk) return false;

      const deleted = await cacheStorage.delete(LEGACY_READER_CACHE_NAME);
      if (deleted) {
        this.legacyCacheCleaned = true;
        this.emitSnapshot();
      }
      return deleted;
    } catch {
      return false;
    }
  }
}

export function createSwUpdateCoordinator(deps?: Partial<SwUpdateCoordinatorDeps>): SwUpdateCoordinator {
  return new SwUpdateCoordinator({
    ...createBrowserDeps(),
    ...(deps || {}),
  });
}

export const swUpdateCoordinator = createSwUpdateCoordinator();
