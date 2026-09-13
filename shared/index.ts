/**
 * The wire protocol shared by the client and the server: message names and
 * payloads, validators, frame types, close codes and the protocol version.
 * Web-standard TypeScript only — no Node, DOM or platform imports.
 */
export * from './messages.ts';
export * from './validators.ts';
export * from './frames.ts';
export * from './closeCodes.ts';
export * from './version.ts';
