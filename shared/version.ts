/**
 * The wire protocol version. Raised only for breaking changes; the client sends
 * it as `?v=` on connect and an outdated client is closed with `4004`.
 */
export const PROTOCOL_VERSION = 1;
