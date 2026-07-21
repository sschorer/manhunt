import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useWakeLock } from './useWakeLock.ts';

/** A fake `WakeLockSentinel` whose `release` fires the registered listeners. */
function makeSentinel() {
  const listeners: Array<() => void> = [];
  const sentinel = {
    released: false,
    addEventListener: vi.fn((_type: string, cb: () => void) => listeners.push(cb)),
    removeEventListener: vi.fn((_type: string, cb: () => void) => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    }),
    release: vi.fn(async () => {
      sentinel.released = true;
    }),
    // Simulate the browser/OS dropping the lock (e.g. page hidden).
    fireRelease() {
      listeners.forEach((cb) => cb());
    },
  };
  return sentinel;
}

type FakeSentinel = ReturnType<typeof makeSentinel>;

let request: ReturnType<typeof vi.fn>;

/** Install `navigator.wakeLock` with a `request` we control. */
function installWakeLock(impl: () => Promise<unknown>) {
  request = vi.fn(impl);
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: { request },
  });
}

function removeWakeLock() {
  Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, 'wakeLock');
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

beforeEach(() => {
  setVisibility('visible');
});

afterEach(() => {
  removeWakeLock();
});

describe('useWakeLock', () => {
  it('reports unsupported when the API is missing', () => {
    removeWakeLock();
    const { result } = renderHook(() => useWakeLock(true));
    expect(result.current).toBe('unsupported');
  });

  it('stays idle until enabled', () => {
    installWakeLock(async () => makeSentinel());
    const { result } = renderHook(() => useWakeLock(false));
    expect(result.current).toBe('idle');
    expect(request).not.toHaveBeenCalled();
  });

  it('acquires a screen lock when enabled', async () => {
    const sentinel = makeSentinel();
    installWakeLock(async () => sentinel);
    const { result } = renderHook(() => useWakeLock(true));

    await waitFor(() => expect(result.current).toBe('held'));
    expect(request).toHaveBeenCalledWith('screen');
  });

  it('falls back gracefully when the request is denied', async () => {
    installWakeLock(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    const { result } = renderHook(() => useWakeLock(true));

    await waitFor(() => expect(result.current).toBe('denied'));
  });

  it('re-acquires the lock after it is released and the page returns to view', async () => {
    let sentinel: FakeSentinel = makeSentinel();
    installWakeLock(async () => sentinel);
    const { result } = renderHook(() => useWakeLock(true));
    await waitFor(() => expect(result.current).toBe('held'));

    // The OS drops the lock (page hidden): we reflect it as released.
    act(() => sentinel.fireRelease());
    expect(result.current).toBe('released');

    // Back to visible → re-acquire a fresh lock.
    sentinel = makeSentinel();
    act(() => {
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(result.current).toBe('held'));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('releases the lock on unmount', async () => {
    const sentinel = makeSentinel();
    installWakeLock(async () => sentinel);
    const { result, unmount } = renderHook(() => useWakeLock(true));
    await waitFor(() => expect(result.current).toBe('held'));

    unmount();
    await waitFor(() => expect(sentinel.release).toHaveBeenCalled());
  });
});
