import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type Game } from '@manhunt/shared';
import { connectToGame, HEARTBEAT_INTERVAL_MS, PONG_TIMEOUT_MS, type GameConnection } from './gameConnection.ts';

/** A WebSocket the test drives by hand: it opens, receives and closes on command. */
class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  binaryType = 'blob';
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason, wasClean: true }));
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  receive(data: unknown): void {
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    this.dispatchEvent(new MessageEvent('message', { data: text }));
  }
}

const game: Game = {
  id: 'g1',
  roomCode: 'AB2C',
  status: 'lobby',
  createdAt: '2026-09-13T10:00:00.000Z',
  players: [{ id: 'p1', name: 'Ada', role: 'hunter', ready: false, isHost: true }],
};

let connection: GameConnection | undefined;

async function open(options: { requestTimeoutMs?: number } = {}): Promise<FakeWebSocket> {
  connection = connectToGame('g1', { WebSocket: FakeWebSocket, minReconnectDelayMs: 10, ...options });
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const ws = FakeWebSocket.instances[0]!;
  ws.open();
  return ws;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
});

afterEach(() => {
  connection?.close();
  connection = undefined;
  vi.useRealTimers();
});

describe('connectToGame', () => {
  it("opens the Game's socket on this page's host with the protocol version", async () => {
    const ws = await open();

    expect(ws.url).toBe(`ws://${location.host}/ws/games/g1?v=${PROTOCOL_VERSION}`);
  });

  it('hands server events to the listeners for that event name', async () => {
    const ws = await open();
    const lobby = vi.fn();
    const gameOver = vi.fn();
    connection!.on('lobby_update', lobby);
    connection!.on('game_over', gameOver);

    ws.receive({ t: 'lobby_update', d: { game } });

    expect(lobby).toHaveBeenCalledWith({ game });
    expect(gameOver).not.toHaveBeenCalled();
  });

  it('stops calling a listener once it unsubscribes', async () => {
    const ws = await open();
    const lobby = vi.fn();
    const unsubscribe = connection!.on('lobby_update', lobby);

    unsubscribe();
    ws.receive({ t: 'lobby_update', d: { game } });

    expect(lobby).not.toHaveBeenCalled();
  });

  it('resolves a request with the reply that answers its id', async () => {
    const ws = await open();

    const first = connection!.request('set_ready', { ready: true });
    const second = connection!.request('start_game', {});
    expect(ws.sent.map((text) => JSON.parse(text))).toEqual([
      { t: 'set_ready', id: 1, d: { ready: true } },
      { t: 'start_game', id: 2, d: {} },
    ]);
    ws.receive({ re: 2, d: { ok: false, error: 'Not yet', code: 'not_ready' } });
    ws.receive({ re: 1, d: { ok: true } });

    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: false, error: 'Not yet', code: 'not_ready' });
  });

  it('fails a request that gets no reply in time with `timeout`', async () => {
    vi.useFakeTimers();
    const ws = await open({ requestTimeoutMs: 5_000 });

    const pending = connection!.request('start_game', {});
    const failed = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    vi.advanceTimersByTime(5_000);

    await failed;
    // A late reply for the timed-out request is ignored.
    ws.receive({ re: 1, d: { ok: true } });
  });

  it('fails pending requests with `disconnected` when the socket drops, and never resends them', async () => {
    const ws = await open();

    const pending = connection!.request('start_game', {});
    ws.close(1006);

    await expect(pending).rejects.toMatchObject({ code: 'disconnected' });
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    FakeWebSocket.instances[1]!.open();
    expect(FakeWebSocket.instances[1]!.sent).toEqual([]);
  });

  it('fails a request made while the socket is not open with `disconnected`', async () => {
    connection = connectToGame('g1', { WebSocket: FakeWebSocket });

    await expect(connection.request('start_game', {})).rejects.toMatchObject({ code: 'disconnected' });
  });

  it.each([4001, 4002, 4003, 4004])('stops reconnecting after the server closes with %i', async (code) => {
    const ws = await open();
    const onClose = vi.fn();
    connection!.onClose(onClose);

    ws.close(code);

    expect(onClose).toHaveBeenCalledWith(code);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  describe('heartbeat', () => {
    it('sends "ping" on an interval and keeps a socket that answers', async () => {
      vi.useFakeTimers();
      const ws = await open();

      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      expect(ws.sent).toEqual(['ping']);
      ws.receive('pong');
      vi.advanceTimersByTime(PONG_TIMEOUT_MS);

      expect(ws.readyState).toBe(FakeWebSocket.OPEN);
    });

    it('does not hand "pong" to event listeners', async () => {
      const ws = await open();
      const lobby = vi.fn();
      connection!.on('lobby_update', lobby);

      ws.receive('pong');

      expect(lobby).not.toHaveBeenCalled();
    });

    it('drops a socket that stays silent after a ping', async () => {
      vi.useFakeTimers();
      const ws = await open();

      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS + PONG_TIMEOUT_MS);

      expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
    });

    it('counts any server message as proof of life', async () => {
      vi.useFakeTimers();
      const ws = await open();

      vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
      ws.receive({ t: 'lobby_update', d: { game } });
      vi.advanceTimersByTime(PONG_TIMEOUT_MS);

      expect(ws.readyState).toBe(FakeWebSocket.OPEN);
    });
  });
});
