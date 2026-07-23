import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { Socket } from 'socket.io-client';
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
