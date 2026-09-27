# workerd configuration for the self-hosted Docker target.
#
# Hand-maintained on purpose: it is the one place where the Docker target and
# Cloudflare can drift apart, so it stays readable and is kept next to
# `wrangler.jsonc` — the same Worker bundle runs on both. `server/deploy.test.ts`
# checks the two configs against each other, and the end-to-end check in CI runs
# a real Game against the image.
#
# Paths are relative to the directory this file sits in. `deploy/Dockerfile` lays
# that out as:
#
#   /app/config.capnp      this file
#   /app/worker/index.js   the Worker bundle          (dist-worker/)
#   /app/worker/assets.js  the asset Worker bundle    (dist-assets/)
#   /app/public/           the built PWA              (dist-next/)
#   /data/games/           Durable Object storage, on the Compose volume
#
# Run with: workerd serve /app/config.capnp --experimental
# (`--experimental` is required for on-disk Durable Object storage.)

using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    # The asset Worker owns the socket: it serves the PWA and hands `app` the
    # routes Cloudflare's `run_worker_first` would.
    (name = "assets", worker = .assetWorker),
    (name = "app", worker = .appWorker),
    (name = "public", disk = (path = "/app/public")),
    (name = "games", disk = (path = "/data/games", writable = true)),
    (name = "internet", network = .internet),
  ],

  sockets = [
    # Plain HTTP; TLS is terminated by Caddy or by a Cloudflare Tunnel in front.
    (name = "http", address = "*:8080", http = (), service = "assets"),
  ],
);

# The backend: the same bundle Cloudflare runs, with the bindings from
# `wrangler.jsonc` supplied by the container's environment instead.
const appWorker :Workerd.Worker = (
  modules = [
    (name = "worker", esModule = embed "worker/index.js"),
  ],
  compatibilityDate = "2026-09-01",

  durableObjectNamespaces = [
    ( className = "GameRoom",
      # NEVER CHANGE THIS. It names the directory under /data/games that every
      # Game's SQLite file lives in; a new key orphans every stored Game.
      uniqueKey = "manhunt-gameroom",
      enableSql = true ),
  ],
  durableObjectStorage = (localDisk = "games"),

  bindings = [
    (name = "GAMES", durableObjectNamespace = "GameRoom"),
    # `wrangler.jsonc` sets these as Worker `vars`; here the operator sets them
    # in the environment. Unset leaves the binding null, which keeps the default.
    (name = "DISCONNECT_GRACE_S", fromEnvironment = "DISCONNECT_GRACE_S"),
    (name = "PING_INTERVAL_S", fromEnvironment = "PING_INTERVAL_S"),
    (name = "GAME_DURATION_S", fromEnvironment = "GAME_DURATION_S"),
    # Only needed when the proxy in front rewrites the `Host` header; otherwise
    # the Origin check compares `Origin` against `Host` on its own.
    (name = "PUBLIC_ORIGIN", fromEnvironment = "PUBLIC_ORIGIN"),
  ],
);

# What Cloudflare does with Workers Static Assets: serve the built PWA, fall back
# to the app shell, and let the Worker answer its own routes first.
const assetWorker :Workerd.Worker = (
  modules = [
    (name = "assets", esModule = embed "worker/assets.js"),
  ],
  compatibilityDate = "2026-09-01",
  bindings = [
    (name = "APP", service = "app"),
    (name = "ASSETS", service = "public"),
  ],
);

# What the Workers may reach with `fetch()`: the push services, and nothing on
# this host or this network. Both Workers use it — it is the default
# `globalOutbound` — so the Web Push endpoint check has a second line of defence
# underneath it.
const internet :Workerd.Network = (
  allow = ["public"],
  deny = [
    # NAT64: reaches private IPv4 space (including this host) over IPv6.
    "64:ff9b::/96",
    # "This host on this network" (RFC 1122 §3.2.1.3), never a push service.
    "0.0.0.0/8",
  ],
  # Required, and easy to lose: defining `internet` at all replaces the implicit
  # service workerd would otherwise provide, and `trustBrowserCas` defaults to
  # false. Without this line workerd has no TLS network at all, and every
  # outbound `fetch()` to an https:// URL fails with "this HttpClient doesn't
  # support HTTPS" — which is every Web Push send.
  tlsOptions = (trustBrowserCas = true),
);
