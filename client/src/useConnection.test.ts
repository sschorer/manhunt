import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { GameConnection } from './transport/gameConnection.ts';
import { useConnection } from './useConnection.ts';

afterEach(() => cleanup());

/** A Game connection whose open state and server close the test drives. */
function fakeConnection(open: boolean) {
  let openListener: ((isOpen: boolean) => void) | undefined;
  let closeListener: ((code: number) => void) | undefined;
  const connection = {
    isOpen: () => open,
    onOpenChange(listener: (isOpen: boolean) => void) {
      openListener = listener;
      return () => {
        openListener = undefined;
      };
    },
    onClose(listener: (code: number) => void) {
      closeListener = listener;
      return () => {
        closeListener = undefined;
      };
    },
  };
  return {
    connection: connection as unknown as GameConnection,
    setOpen(value: boolean) {
      open = value;
      act(() => openListener?.(value));
    },
    serverClose(code: number) {
      act(() => closeListener?.(code));
    },
    listening: () => openListener !== undefined || closeListener !== undefined,
  };
}

describe('useConnection', () => {
  it('follows the Game connection as it drops and comes back', () => {
    const fake = fakeConnection(true);
    const { result } = renderHook(() => useConnection(fake.connection));
    expect(result.current).toBe('connected');

    fake.setOpen(false);
    expect(result.current).toBe('reconnecting');

    fake.setOpen(true);
    expect(result.current).toBe('connected');
  });

  it('starts reconnecting while the Game connection is not open yet', () => {
    const fake = fakeConnection(false);
    const { result } = renderHook(() => useConnection(fake.connection));
    expect(result.current).toBe('reconnecting');
  });

  it('starts reconnecting when there is no connection at all', () => {
    const { result } = renderHook(() => useConnection(null));
    expect(result.current).toBe('reconnecting');
  });

  it('reports offline once the Game closes the connection for good', () => {
    const fake = fakeConnection(true);
    const { result } = renderHook(() => useConnection(fake.connection));

    fake.setOpen(false);
    fake.serverClose(4001);

    expect(result.current).toBe('offline');
  });

  it('stops listening on unmount', () => {
    const fake = fakeConnection(true);
    const { unmount } = renderHook(() => useConnection(fake.connection));

    unmount();

    expect(fake.listening()).toBe(false);
  });
});
