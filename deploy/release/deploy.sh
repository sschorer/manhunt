#!/usr/bin/env bash
# Deploy this Manhunt release to Cloudflare, from your own machine. See README.md.
set -euo pipefail
cd "$(dirname "$0")"

usage() {
  cat <<'TEXT'
Deploy this Manhunt release to Cloudflare, from your own machine.

  cp .env.example .env     # account id, domain, optional settings
  $EDITOR .env
  ./deploy.sh              # render the config, deploy, verify /health

  ./deploy.sh --config-only    # only render wrangler.jsonc, deploy nothing

It reads .env, writes wrangler.jsonc from wrangler.template.jsonc, runs the
wrangler deploy this release was tested with, and then reads /health on your
domain to confirm it reports this release's version. It waits HEALTH_TIMEOUT_S
seconds (120 by default) for that, polling every HEALTH_POLL_S.

Nothing in GitHub deploys to Cloudflare (ADR-0008): this script is the only thing
that does, it runs where your credentials already are, and it needs no token of
its own — wrangler brings its own browser login (`wrangler login`).

The VAPID keys are never written here. Hand them to Cloudflare directly, once:
  wrangler secret put VAPID_PUBLIC_KEY
  wrangler secret put VAPID_PRIVATE_KEY
TEXT
}

TEMPLATE=wrangler.template.jsonc
CONFIG=wrangler.jsonc
# How long the domain may take to answer `/health` after a deploy: a brand-new
# Custom Domain has to get its DNS record and its certificate first. Override both
# from the environment if your domain is slower than that, or faster.
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-120}"
HEALTH_POLL_S="${HEALTH_POLL_S:-5}"

CONFIG_ONLY=0
case "${1-}" in
  --config-only) CONFIG_ONLY=1 ;;
  -h | --help)
    usage
    exit 0
    ;;
  '') ;;
  *)
    echo "deploy.sh: unknown option '$1' (try --help)" >&2
    exit 2
    ;;
esac

die() {
  echo "deploy.sh: $1" >&2
  exit 1
}

[ -f release.env ] || die "release.env is missing — is this an unpacked Manhunt release?"
[ -f "$TEMPLATE" ] || die "$TEMPLATE is missing — is this an unpacked Manhunt release?"
[ -f .env ] || die "no .env here yet — run 'cp .env.example .env' and fill it in"

# The deployer's settings. Read as shell, so a value with spaces has to be quoted;
# `.env.example` says so.
# shellcheck source=/dev/null
. ./.env
# What this release is — its version, the protocol and snapshot versions it speaks,
# and the exact wrangler it was tested with. Read second, so nothing in `.env` can
# talk this release into being another one.
# shellcheck source=/dev/null
. ./release.env

# Every value that reaches the rendered config is checked here, so a typo fails
# before wrangler is called — and so no value can smuggle anything into the JSON.
CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID-}"
MANHUNT_DOMAIN="${MANHUNT_DOMAIN-}"
VAPID_SUBJECT="${VAPID_SUBJECT-}"
DISCONNECT_GRACE_S="${DISCONNECT_GRACE_S-}"
PING_INTERVAL_S="${PING_INTERVAL_S-}"
GAME_DURATION_S="${GAME_DURATION_S-}"

[[ $CLOUDFLARE_ACCOUNT_ID =~ ^[0-9a-fA-F]{32}$ ]] ||
  die "CLOUDFLARE_ACCOUNT_ID must be the 32 hex characters shown as 'Account ID' in the dashboard"
[[ $MANHUNT_DOMAIN =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ && $MANHUNT_DOMAIN == *.* ]] ||
  die "MANHUNT_DOMAIN must be a hostname like manhunt.example.com"
[[ -z $VAPID_SUBJECT || $VAPID_SUBJECT =~ ^(mailto:[^[:space:]\"|]+|https://[^[:space:]\"|]+)$ ]] ||
  die "VAPID_SUBJECT must be empty, a mailto: address or an https:// URL"
# The rule overrides, in seconds. Empty is the normal case: it leaves the game's
# own default in place, so those defaults live in one place only (the code).
for name in DISCONNECT_GRACE_S PING_INTERVAL_S GAME_DURATION_S; do
  [[ -z ${!name} || ${!name} =~ ^[0-9]+$ ]] || die "$name must be a whole number of seconds, or empty"
done

echo "── Rendering $CONFIG for ${MANHUNT_DOMAIN}"
sed \
  -e "s|__CLOUDFLARE_ACCOUNT_ID__|${CLOUDFLARE_ACCOUNT_ID}|g" \
  -e "s|__MANHUNT_DOMAIN__|${MANHUNT_DOMAIN}|g" \
  -e "s|__VAPID_SUBJECT__|${VAPID_SUBJECT}|g" \
  -e "s|__DISCONNECT_GRACE_S__|${DISCONNECT_GRACE_S}|g" \
  -e "s|__PING_INTERVAL_S__|${PING_INTERVAL_S}|g" \
  -e "s|__GAME_DURATION_S__|${GAME_DURATION_S}|g" \
  "$TEMPLATE" >"$CONFIG"
if left="$(grep -o '__[A-Z_]\+__' "$CONFIG" | sort -u | tr '\n' ' ')" && [ -n "$left" ]; then
  die "$CONFIG still has placeholders in it (${left% }) — $TEMPLATE has one this script doesn't fill"
fi
echo "   ok — $CONFIG written (it holds your account id; keep it to yourself)"

if [ "$CONFIG_ONLY" = 1 ]; then
  echo "── Stopping here: --config-only"
  exit 0
fi

if [ -z "$VAPID_SUBJECT" ]; then
  echo "   note — VAPID_SUBJECT is empty, so Web Push stays off for this deployment"
fi

# The same wrangler this release was tested with. Pinned, because it is what
# uploads the bundle and runs the Durable Object migration.
echo "── Deploying ${MANHUNT_VERSION} with wrangler ${WRANGLER_VERSION}"
npx --yes "wrangler@${WRANGLER_VERSION}" deploy \
  --config "$CONFIG" \
  --message "Manhunt ${MANHUNT_VERSION}"

# What the deploy is judged on: the domain answering with this release's version.
# Until it does, the deployment being served is still the previous one.
echo "── Checking https://${MANHUNT_DOMAIN}/health reports ${MANHUNT_VERSION}"
deadline=$((SECONDS + HEALTH_TIMEOUT_S))
body=""
while :; do
  body="$(curl -fsS --max-time 10 "https://${MANHUNT_DOMAIN}/health" 2>/dev/null || true)"
  if grep -Eq "\"version\"[[:space:]]*:[[:space:]]*\"${MANHUNT_VERSION}\"" <<<"$body"; then
    echo "   ok — ${body}"
    echo ""
    echo "Deployed. Protocol version ${MANHUNT_PROTOCOL_VERSION}, snapshot version ${MANHUNT_SNAPSHOT_VERSION}."
    exit 0
  fi
  [ "$SECONDS" -lt "$deadline" ] || break
  sleep "$HEALTH_POLL_S"
done

echo "deploy.sh: https://${MANHUNT_DOMAIN}/health did not report ${MANHUNT_VERSION} within ${HEALTH_TIMEOUT_S}s" >&2
if [ -n "$body" ]; then
  echo "deploy.sh: it answered: ${body}" >&2
fi
echo "deploy.sh: on a brand-new Custom Domain that can be DNS or the certificate rather than the deploy — check the dashboard." >&2
exit 1
