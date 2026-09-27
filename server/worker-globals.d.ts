// Release version injected at build time by Vite (and by the Worker Vitest
// config) through `define`. See scripts/release-version.ts.
declare const __MANHUNT_VERSION__: string;

declare namespace Cloudflare {
  interface Env {
    GAMES: DurableObjectNamespace<import('./rooms/GameRoom.ts').GameRoom>;
    /**
     * The public origin sockets must come from, when the `Host` is internal
     * (e.g. behind a proxy).
     *
     * This and the rule overrides below are Worker `vars` on Cloudflare, and
     * workerd `fromEnvironment` bindings on the Docker target — where a variable
     * the operator didn't set binds to null rather than being absent.
     */
    PUBLIC_ORIGIN?: string | null;
    /** Rule overrides in seconds; see `server/rules.ts`. */
    DISCONNECT_GRACE_S?: string | null;
    PING_INTERVAL_S?: string | null;
    GAME_DURATION_S?: string | null;
    /**
     * The Web Push (VAPID) key pair and the operator's contact subject; see
     * `server/push/keys.ts`. On Cloudflare the keys are secrets (`wrangler secret
     * put`) and the subject is a Worker variable. Without all three, push is off.
     */
    VAPID_PUBLIC_KEY?: string | null;
    VAPID_PRIVATE_KEY?: string | null;
    VAPID_SUBJECT?: string | null;
  }
}
