import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { Socket } from 'socket.io-client';
import type { GameConnection } from './transport/gameConnection.ts';
import { useConnection } from './useConnection.ts';

/** A fake socket that records handlers so a test can drive connect/disconnect. */
function fakeSocket(connected = false) {
  const handlers = new Map<string, (payload?: unknown) => void>();
  const socket = {
    connected,
    on(event: string, cb: (payload?: unknown) => void) {
      handlers.set(event, cb);
    },
    off(event: string) {
      handlers.delete(event);
    },
  };
  return {
    socket: socket as unknown as Socket,
    fire(event: string, payload?: unknown) {
      act(() => handlers.get(event)?.(payload));
    },
    setConnected(value: boolean) {
      socket.connected = value;
    },
  };
}

afterEach(() => cleanup());

describe('useConnection', () => {
  it('starts reconnecting before the first connect', () => {
    const fake = fakeSocket(false);
    const { result } = renderHook(() => useConnection(fake.socket));
    expect(result.current).toBe('reconnecting');
  });

  it('starts connected when the socket is already up', () => {
    const fake = fakeSocket(true);
    const { result } = renderHook(() => useConnection(fake.socket));
    expect(result.current).toBe('connected');
  });

  it('reports connected once the socket connects', () => {
    const fake = fakeSocket(false);
    const { result } = renderHook(() => useConnection(fake.socket));
    fake.fire('connect');
    expect(result.current).toBe('connected');
  });

  it('reports reconnecting on a recoverable transport drop', () => {
    const fake = fakeSocket(true);
    const { result } = renderHook(() => useConnection(fake.socket));
    fake.fire('connect');
    fake.fire('disconnect', 'transport close');
    expect(result.current).toBe('reconnecting');
  });

  it('reports offline when the close will not auto-recover', () => {
    const fake = fakeSocket(true);
    const { result } = renderHook(() => useConnection(fake.socket));
    fake.fire('connect');
    fake.fire('disconnect', 'io server disconnect');
    expect(result.current).toBe('offline');

    fake.fire('disconnect', 'io client disconnect');
    expect(result.current).toBe('offline');
  });

  it('recovers to connected after reconnecting', () => {
    const fake = fakeSocket(true);
    const { result } = renderHook(() => useConnection(fake.socket));
    fake.fire('disconnect', 'ping timeout');
    expect(result.current).toBe('reconnecting');
    fake.fire('connect');
    expect(result.current).toBe('connected');
  });
});

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

describe('useConnection with a Game connection', () => {
  it('follows the Game connection rather than the socket', () => {
    const fake = fakeConnection(true);
    const { result } = renderHook(() => useConnection(fakeSocket(false).socket, fake.connection));
    expect(result.current).toBe('connected');

    fake.setOpen(false);
    expect(result.current).toBe('reconnecting');

    fake.setOpen(true);
    expect(result.current).toBe('connected');
  });

  it('starts reconnecting while the Game connection is not open yet', () => {
    const fake = fakeConnection(false);
    const { result } = renderHook(() => useConnection(fakeSocket(true).socket, fake.connection));
    expect(result.current).toBe('reconnecting');
  });

  it('reports offline once the server closes the Game connection for good', () => {
    const fake = fakeConnection(true);
    const { result } = renderHook(() => useConnection(fakeSocket(true).socket, fake.connection));

    fake.setOpen(false);
    fake.serverClose(4001);

    expect(result.current).toBe('offline');
  });

  it('stops listening on unmount', () => {
    const fake = fakeConnection(true);
    const { unmount } = renderHook(() => useConnection(fakeSocket(true).socket, fake.connection));

    unmount();

    expect(fake.listening()).toBe(false);
  });
});
