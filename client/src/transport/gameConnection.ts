import ReconnectingWebSocket from 'partysocket/ws';
import {
  HEARTBEAT,
  isCloseCode,
  isReplyFrame,
  isRequestFrame,
  parseFrame,
  PROTOCOL_VERSION,
  type CloseCode,
  type InboundEventMap,
  type InboundEventName,
  type OutboundEventMap,
  type OutboundEventName,
} from '@manhunt/shared';

/** How often the client proves the socket is alive (spec "Wire protocol"). */
export const HEARTBEAT_INTERVAL_MS = 25_000;
/** How long after a `"ping"` the socket may stay silent before it counts as dead. */
export const PONG_TIMEOUT_MS = 10_000;
/** How long a request waits for its reply by default. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** Why a request failed without a reply. */
export type RequestErrorCode = 'timeout' | 'disconnected';

export class RequestError extends Error {
  readonly code: RequestErrorCode;

  constructor(code: RequestErrorCode) {
    super(code === 'timeout' ? 'The server did not answer in time' : 'The connection to the server dropped');
    this.name = 'RequestError';
    this.code = code;
  }
}

/** One Game's WebSocket on the new backend. */
export interface GameConnection {
  /** Listen for one server event; returns the unsubscribe function. */
  on<K extends OutboundEventName>(name: K, listener: (payload: OutboundEventMap[K]) => void): () => void;
  /** Called when the server closes the socket with an application close code (`4001`–`4004`). */
  onClose(listener: (code: CloseCode) => void): () => void;
  /**
   * Send a request and wait for its reply body. Rejects with a {@link RequestError}
   * on timeout or when the socket drops. Never resent: `start_game` and
   * `claim_catch` are not idempotent.
   */
  request<R = unknown, K extends InboundEventName = InboundEventName>(name: K, payload: InboundEventMap[K]): Promise<R>;
  /** Close the socket for good. */
  close(): void;
}

export interface ConnectOptions {
  /** The WebSocket implementation; tests pass a fake. */
  WebSocket?: unknown;
  requestTimeoutMs?: number;
  /** Delay before the first reconnect attempt; backoff grows from here. */
  minReconnectDelayMs?: number;
}

interface Pending {
  resolve(body: unknown): void;
  reject(error: RequestError): void;
  timer: ReturnType<typeof setTimeout>;
}

function gameSocketUrl(gameId: string): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/ws/games/${encodeURIComponent(gameId)}?v=${PROTOCOL_VERSION}`;
}

/**
 * Open a Game's socket. `partysocket` reconnects with backoff; each reconnect
 * receives a fresh snapshot from the server, so missed messages aren't replayed.
 */
export function connectToGame(gameId: string, options: ConnectOptions = {}): GameConnection {
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const ws = new ReconnectingWebSocket(gameSocketUrl(gameId), [], {
    WebSocket: options.WebSocket,
    minReconnectionDelay: options.minReconnectDelayMs ?? 1_000,
    maxReconnectionDelay: 5_000,
    maxRetries: Infinity,
  });

  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const closeListeners = new Set<(code: CloseCode) => void>();
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let pongTimer: ReturnType<typeof setTimeout> | undefined;

  function stopHeartbeat(): void {
    clearInterval(heartbeat);
    clearTimeout(pongTimer);
    heartbeat = undefined;
    pongTimer = undefined;
  }

  function failPending(): void {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new RequestError('disconnected'));
    }
    pending.clear();
  }

  ws.addEventListener('open', () => {
    stopHeartbeat();
    heartbeat = setInterval(() => {
      ws.send(HEARTBEAT.ping);
      clearTimeout(pongTimer);
      pongTimer = setTimeout(() => ws.reconnect(), PONG_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  });

  ws.addEventListener('message', (event: MessageEvent) => {
    // Any message from the server proves the socket is alive.
    clearTimeout(pongTimer);
    if (typeof event.data !== 'string' || event.data === HEARTBEAT.pong) return;
    const frame = parseFrame(event.data);
    if (!frame) return;
    if (isReplyFrame(frame)) {
      const request = pending.get(frame.re);
      if (!request) return;
      pending.delete(frame.re);
      clearTimeout(request.timer);
      request.resolve(frame.d);
    } else if (!isRequestFrame(frame)) {
      listeners.get(frame.t)?.forEach((listener) => listener(frame.d));
    }
  });

  ws.addEventListener('close', (event: CloseEvent) => {
    stopHeartbeat();
    failPending();
    const { code } = event;
    if (isCloseCode(code)) {
      // The server meant it: don't reconnect.
      ws.close();
      closeListeners.forEach((listener) => listener(code));
    }
  });

  return {
    on(name, listener) {
      const set = listeners.get(name) ?? new Set();
      listeners.set(name, set);
      const entry = listener as (payload: unknown) => void;
      set.add(entry);
      return () => {
        set.delete(entry);
      };
    },

    onClose(listener) {
      closeListeners.add(listener);
      return () => {
        closeListeners.delete(listener);
      };
    },

    request<R>(name: InboundEventName, payload: unknown) {
      // partysocket would queue a message sent while closed and deliver it after
      // reconnecting; requests must never be resent, so fail them instead.
      if (ws.readyState !== ReconnectingWebSocket.OPEN) {
        return Promise.reject(new RequestError('disconnected'));
      }
      const id = nextId;
      nextId += 1;
      return new Promise<R>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new RequestError('timeout'));
        }, requestTimeoutMs);
        pending.set(id, { resolve: resolve as (body: unknown) => void, reject, timer });
        ws.send(JSON.stringify({ t: name, id, d: payload }));
      });
    },

    close() {
      stopHeartbeat();
      failPending();
      ws.close();
    },
  };
}
