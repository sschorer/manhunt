/**
 * Application WebSocket close codes (spec "Wire protocol"). Each tells the
 * client how to react to the server closing its socket.
 */
export const CLOSE_CODES = {
  /** Seat token rejected or Seat gone — forget the stored Seat. */
  seatRejected: 4001,
  /** Game ended — show the end screen. */
  gameEnded: 4002,
  /** Replaced by a newer connection for the same Seat — don't reconnect. */
  replaced: 4003,
  /** Protocol version out of date — reload to get the new build. */
  protocolOutdated: 4004,
} as const;

/** One of the application close codes. */
export type CloseCode = (typeof CLOSE_CODES)[keyof typeof CLOSE_CODES];

const KNOWN_CLOSE_CODES: ReadonlySet<number> = new Set(Object.values(CLOSE_CODES));

/** Whether a received close code is one of ours (vs. a transport code like 1006). */
export function isCloseCode(code: number): code is CloseCode {
  return KNOWN_CLOSE_CODES.has(code);
}
