import { useEffect, useState } from 'react';

/**
 * Lifecycle of a screen wake lock:
 *
 * - `unsupported` — the browser has no Screen Wake Lock API.
 * - `idle` — supported, but not currently requesting a lock (tracking off).
 * - `held` — a lock is active; the screen stays awake.
 * - `released` — the lock was dropped (page hidden or reclaimed by the OS). We
 *   re-acquire automatically when the page becomes visible again.
 * - `denied` — the request was rejected (permissions policy, a user/OS setting,
 *   or low battery). Tracking keeps running without keeping the screen awake.
 */
export type WakeLockStatus = 'unsupported' | 'idle' | 'held' | 'released' | 'denied';

/** Whether this browser exposes the Screen Wake Lock API. */
export function wakeLockSupported(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

/**
 * Hold a screen {@link https://developer.mozilla.org/docs/Web/API/Screen_Wake_Lock_API
 * Wake Lock} for as long as `enabled` is true, so GPS tracking keeps running
 * with the screen on. Browsers auto-release the lock whenever the page is
 * hidden, so we re-acquire it on the next `visibilitychange` back to visible.
 *
 * The API is best-effort: if the request is denied — no support, a blocking
 * permissions policy, or the OS reclaiming it — the hook reports the reason and
 * the caller carries on without the lock. It never throws.
 */
export function useWakeLock(enabled: boolean): WakeLockStatus {
  const supported = wakeLockSupported();
  const [status, setStatus] = useState<WakeLockStatus>(supported ? 'idle' : 'unsupported');

  useEffect(() => {
    // When off/unsupported the resting status is already set by the initial
    // state (first render) or the previous run's cleanup (a later toggle-off).
    if (!enabled || !supported) return;

    // `cancelled` guards against an async request that resolves after cleanup.
    let cancelled = false;
    let sentinel: WakeLockSentinel | null = null;

    const handleRelease = (): void => {
      // Fired when the lock drops for any reason (page hidden, OS reclaim, or
      // our own release). Clear it so the visibility handler can re-acquire.
      sentinel = null;
      if (!cancelled) setStatus('released');
    };

    const acquire = async (): Promise<void> => {
      // The API only grants a lock to a visible page and rejects otherwise;
      // skip quietly here and let `visibilitychange` retry when it returns.
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      try {
        const next = await navigator.wakeLock.request('screen');
        if (cancelled) {
          void next.release();
          return;
        }
        sentinel = next;
        next.addEventListener('release', handleRelease);
        setStatus('held');
      } catch {
        // Graceful fallback: keep tracking, just without the screen lock.
        if (!cancelled) setStatus('denied');
      }
    };

    const onVisibility = (): void => {
      if (document.visibilityState === 'visible' && !sentinel) void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      if (sentinel) {
        sentinel.removeEventListener('release', handleRelease);
        void sentinel.release();
        sentinel = null;
      }
      setStatus(supported ? 'idle' : 'unsupported');
    };
  }, [enabled, supported]);

  return status;
}
