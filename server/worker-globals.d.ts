// Release version injected at build time by Vite (and by the Worker Vitest
// config) through `define`. See scripts/release-version.ts.
declare const __MANHUNT_VERSION__: string;

declare namespace Cloudflare {
  interface Env {
    ECHO: DurableObjectNamespace<import('./rooms/EchoRoom.ts').EchoRoom>;
  }
}
