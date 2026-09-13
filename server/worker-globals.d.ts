// Release version injected at build time by Vite (and by the Worker Vitest
// config) through `define`. See scripts/release-version.ts.
declare const __MANHUNT_VERSION__: string;

declare namespace Cloudflare {
  interface Env {
    GAMES: DurableObjectNamespace<import('./rooms/GameRoom.ts').GameRoom>;
    /** The public origin sockets must come from, when the `Host` is internal (e.g. behind a proxy). */
    PUBLIC_ORIGIN?: string;
  }
}
