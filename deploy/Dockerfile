# The self-hosted target: the same Worker bundle Cloudflare runs, on a pinned
# workerd. Build from the repo root:
#
#   docker build -f deploy/Dockerfile -t ghcr.io/sschorer/manhunt:dev .
#
# See deploy/config.capnp for the layout this lays out under /app, and
# deploy/compose.yml for how it is run.

# ── The PWA, the Worker bundle and the asset Worker ──────────────────────────
# glibc, not Alpine: the build loads @cloudflare/vite-plugin, which ships workerd.
FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package*.json ./
COPY client/package.json ./client/
RUN npm ci
COPY . .
# The release version baked into /health comes from the tag, or from
# `git describe` — which has no .git here, so pass it in on a release build.
ARG MANHUNT_VERSION
ENV MANHUNT_VERSION=${MANHUNT_VERSION}
# `build:worker-backend` is the temporary switch that points the client at the new
# backend; it writes the PWA to dist-next/ and the Worker to dist-worker/. The
# cutover makes that the plain `build`, and this becomes `npm run build`.
RUN npm run build:worker-backend && npm run build:assets

# ── The pinned workerd binary ───────────────────────────────────────────────
# Pinned exactly, and changed only through a normal release: its on-disk Durable
# Object storage is experimental. Keep this equal to the workerd version the test
# suite runs on — server/deploy.test.ts checks that it is.
FROM node:24-bookworm-slim AS runtime-deps
WORKDIR /pin
ARG WORKERD_VERSION=1.20260911.1
RUN npm install --no-save --no-package-lock --no-audit --no-fund "workerd@${WORKERD_VERSION}" \
 && install -m 0755 node_modules/workerd/bin/workerd /workerd \
 && /workerd --version

# ── The image ───────────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS runtime
# curl is the health check; ca-certificates is for the Web Push requests.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN useradd --system --uid 10001 --user-group --home-dir /app --shell /usr/sbin/nologin manhunt

WORKDIR /app
COPY --from=runtime-deps /workerd /usr/local/bin/workerd
COPY --from=build /src/dist-worker/index.js ./worker/index.js
COPY --from=build /src/dist-assets/index.js ./worker/assets.js
COPY --from=build /src/dist-next/ ./public/
COPY deploy/config.capnp ./config.capnp

# The Durable Object storage directory, owned by the app user so a fresh named
# volume mounted at /data inherits that ownership.
RUN install -d -o manhunt -g manhunt /data /data/games
VOLUME ["/data"]

USER manhunt
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8080/health || exit 1

# `--experimental` is what turns on on-disk Durable Object storage.
ENTRYPOINT ["workerd", "serve", "/app/config.capnp", "--experimental"]
