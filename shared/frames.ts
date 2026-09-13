/**
 * The JSON frame shapes carried over a Game's WebSocket (spec "Wire protocol").
 *
 * - **Event** `{ t, d }` — server broadcasts and fire-and-forget client messages
 *   such as `position_update`.
 * - **Request** `{ t, id, d }` — every client message that expects a reply.
 * - **Reply** `{ re, d }` — answers the request whose `id` equals `re`.
 *
 * Heartbeats are not frames: the literal text `"ping"` is answered with `"pong"`.
 */
import type { InboundEventMap, InboundEventName, OutboundEventMap, OutboundEventName } from './messages.ts';

export interface EventFrame<T extends string = string, D = unknown> {
  t: T;
  d: D;
}

export interface RequestFrame<T extends string = string, D = unknown> {
  t: T;
  id: number;
  d: D;
}

export interface ReplyFrame<D = unknown> {
  re: number;
  d: D;
}

export type Frame = EventFrame | RequestFrame | ReplyFrame;

/** Any event frame the server sends, discriminated by `t`. */
export type ServerEventFrame = {
  [K in OutboundEventName]: EventFrame<K, OutboundEventMap[K]>;
}[OutboundEventName];

/** Any event or request frame a client sends, discriminated by `t`. */
export type ClientFrame = {
  [K in InboundEventName]: EventFrame<K, InboundEventMap[K]> | RequestFrame<K, InboundEventMap[K]>;
}[InboundEventName];

/** The literal heartbeat text frames. */
export const HEARTBEAT = { ping: 'ping', pong: 'pong' } as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Parse a text frame into its envelope. Returns `undefined` for anything that is
 * not valid JSON or not one of the three frame shapes. Only the envelope is
 * checked; the payload `d` is still untrusted and goes through its validator.
 */
export function parseFrame(text: string): Frame | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const body = asRecord(value);
  if (!body) return undefined;
  if (Number.isInteger(body.re) && !('t' in body)) {
    return { re: body.re as number, d: body.d };
  }
  if (typeof body.t !== 'string' || body.t.length === 0) return undefined;
  if (!('id' in body)) return { t: body.t, d: body.d };
  if (!Number.isInteger(body.id)) return undefined;
  return { t: body.t, id: body.id as number, d: body.d };
}

export function isReplyFrame(frame: Frame): frame is ReplyFrame {
  return 're' in frame;
}

export function isRequestFrame(frame: Frame): frame is RequestFrame {
  return 'id' in frame;
}

export function isEventFrame(frame: Frame): frame is EventFrame {
  return !isReplyFrame(frame) && !isRequestFrame(frame);
}
