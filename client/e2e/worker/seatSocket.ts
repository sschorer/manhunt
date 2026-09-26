import type { Page } from '@playwright/test';
import { PROTOCOL_VERSION } from '../../../shared/version.ts';

/**
 * A second socket on the Game, opened inside a player's own page and driven
 * from the test. It is how a spec plays the parts of the protocol the UI has no
 * control for yet — setting a Boundary, starting the Game from a script,
 * claiming a Catch — while the Seat cookie stays where it belongs: `HttpOnly`,
 * in the browser that was seated.
 *
 * The Game only keeps the newest socket per Seat, so opening this one closes the
 * page's own (close `4003`, which the client does not reconnect from): whichever
 * player the spec drives this way stops playing through its UI.
 */
export interface SeatSocket {
  /** The Game the page holds a Seat in. */
  gameId: string;
  /** Send a request and wait for its reply body. */
  request<T = Record<string, unknown>>(t: string, d: unknown): Promise<T>;
  /** Send an event frame, which gets no reply. */
  send(t: string, d: unknown): Promise<void>;
  /** Take the first frame of type `t` the Game sent and hasn't been taken yet. */
  next<T = unknown>(t: string): Promise<T>;
}

/** The bridge the page keeps on `window` for the test to call into. */
interface SeatBridge {
  gameId: string;
  request(t: string, d: unknown): Promise<unknown>;
  send(t: string, d: unknown): void;
  next(t: string): Promise<unknown>;
}

type SeatWindow = Window & { __manhuntSeat?: SeatBridge };

/** Open the Game's socket inside `page`, using the Seat that page already holds. */
export async function openSeatSocket(page: Page): Promise<SeatSocket> {
  const gameId = await page.evaluate(async (protocol: number) => {
    const seat = JSON.parse(localStorage.getItem('manhunt.seat') ?? '{}') as { gameId?: string };
    if (!seat.gameId) throw new Error('the page holds no Seat');
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${scheme}//${location.host}/ws/games/${seat.gameId}?v=${protocol}`);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('the Game refused the socket'));
    });

    const frames: { t?: string; re?: number; d?: unknown }[] = [];
    const waiting: (() => void)[] = [];
    ws.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data !== 'string' || event.data === 'pong') return;
      frames.push(JSON.parse(event.data) as { t?: string; re?: number; d?: unknown });
      for (const wake of waiting.splice(0)) wake();
    });

    /** Take the first frame that matches, waiting for it if it hasn't arrived. */
    const take = async (match: (frame: { t?: string; re?: number }) => boolean): Promise<unknown> => {
      for (;;) {
        const index = frames.findIndex(match);
        if (index >= 0) return frames.splice(index, 1)[0]!.d;
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
    };

    let lastId = 0;
    (window as SeatWindow).__manhuntSeat = {
      gameId: seat.gameId,
      send: (t, d) => ws.send(JSON.stringify({ t, d })),
      request: (t, d) => {
        lastId += 1;
        const id = lastId;
        ws.send(JSON.stringify({ t, id, d }));
        return take((frame) => frame.re === id);
      },
      next: (t) => take((frame) => frame.t === t),
    };
    return seat.gameId;
  }, PROTOCOL_VERSION);

  /** Call one of the bridge's methods inside the page. */
  const call = (method: 'request' | 'send' | 'next', t: string, d: unknown): Promise<unknown> =>
    page.evaluate(
      ({ method, t, d }) => {
        const seat = (window as SeatWindow).__manhuntSeat;
        if (!seat) throw new Error('no Seat socket is open in this page');
        return (seat[method] as (t: string, d: unknown) => unknown)(t, d);
      },
      { method, t, d },
    );

  return {
    gameId,
    request: <T>(t: string, d: unknown) => call('request', t, d) as Promise<T>,
    send: async (t: string, d: unknown) => {
      await call('send', t, d);
    },
    next: <T>(t: string) => call('next', t, undefined) as Promise<T>,
  };
}
