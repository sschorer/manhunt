#!/usr/bin/env sh
# Verify issue #5 acceptance against a running stack (`docker compose up -d`):
#   1. the app is reachable over HTTPS at $DOMAIN
#   2. a WebSocket (Socket.IO / WSS) upgrade succeeds through the Caddy proxy
#
# Usage:
#   DOMAIN=manhunt.example.com scripts/verify-proxy.sh
#   DOMAIN=localhost scripts/verify-proxy.sh      # local: -k trusts Caddy's CA
#
# Exits non-zero on the first failed check.
set -eu

DOMAIN="${DOMAIN:-localhost}"
BASE="https://${DOMAIN}"

# Caddy's internal CA (localhost/loopback) isn't in the system trust store, so
# skip verification for local hostnames; verify certs for real domains.
INSECURE=""
case "$DOMAIN" in
  localhost|127.0.0.1|::1|*.localhost) INSECURE="-k" ;;
esac

fail() { echo "FAIL: $1" >&2; exit 1; }

echo "1/2 HTTPS at ${BASE}/health"
# shellcheck disable=SC2086
body="$(curl $INSECURE -fsS --max-time 10 "${BASE}/health")" \
  || fail "GET ${BASE}/health did not return success over HTTPS"
case "$body" in
  *'"ok":true'*) echo "     ok — $body" ;;
  *) fail "unexpected /health body: $body" ;;
esac

echo "2/2 WebSocket upgrade through the proxy"
# Ask the Socket.IO endpoint for a raw WebSocket upgrade and assert Caddy/app
# answer 101 Switching Protocols (i.e. the upgrade tunnel was established).
WS_URL="${BASE}/socket.io/?EIO=4&transport=websocket"
# shellcheck disable=SC2086
status="$(curl $INSECURE -sS --max-time 10 -o /dev/null -w '%{http_code}' \
  --http1.1 \
  -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  "$WS_URL")" || fail "request to $WS_URL failed"
[ "$status" = "101" ] || fail "expected 101 Switching Protocols, got HTTP $status"
echo "     ok — HTTP 101 Switching Protocols"

echo "PASS: HTTPS reachable and WebSocket upgrades succeed through Caddy."
