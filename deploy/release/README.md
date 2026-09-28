# Manhunt on Cloudflare

This is a prebuilt Manhunt release: the Worker bundle Cloudflare runs, the PWA it
serves, and the deploy script that puts both on your own Cloudflare account. The
exact versions in this file are in [`release.env`](./release.env).

```text
worker/index.js          the backend: one Worker plus the GameRoom Durable Object
public/                  the built PWA, served by Workers Static Assets
wrangler.template.jsonc  the deployment config, with no account id and no domain
deploy.sh                renders the config, deploys, verifies /health
.env.example             the settings deploy.sh reads
release.env              what this release is: version, protocol, snapshot, wrangler
```

**Nothing in GitHub deploys to Cloudflare.** There are no Cloudflare credentials
in the repository and no deploy workflow; this release file and `deploy.sh` are
how a deployment happens, from your machine with your own login.

## Before the first deploy

1. **A domain on Cloudflare.** The hostname you want to play on must be in a zone
   whose DNS Cloudflare manages (the free plan is enough), and the name itself
   must be free — attaching it as a Custom Domain replaces any record on it.
2. **Node.js** (the current LTS) and nothing else: `deploy.sh` fetches the exact
   `wrangler` this release was tested with via `npx`.
3. **A Cloudflare login:** `npx wrangler login`, which opens a browser. No API
   token is needed anywhere.

## Verify what you downloaded

```bash
sha256sum --check --ignore-missing SHA256SUMS
gh attestation verify manhunt-cloudflare-<version>.tar.gz --repo sschorer/manhunt
```

Both files are on the GitHub release. The attestation proves the file was built by
this repository's release workflow from the tagged commit.

## Deploy

```bash
tar -xzf manhunt-cloudflare-<version>.tar.gz
cd manhunt-cloudflare-<version>
cp .env.example .env
$EDITOR .env          # CLOUDFLARE_ACCOUNT_ID, MANHUNT_DOMAIN, optional VAPID_SUBJECT
./deploy.sh
```

`deploy.sh` writes `wrangler.jsonc` from the template (that rendered file holds
your account id — it stays on your machine), uploads the bundle with the pinned
`wrangler`, and then reads `https://<your domain>/health` until it reports this
release's version. It exits non-zero if that never happens.

A deploy attaches the Custom Domain and keeps `workers.dev` and preview URLs
disabled, so the deployment answers on that one hostname only.

## Web Push

Push is optional and stays off until all three settings are there: the contact
`VAPID_SUBJECT` in `.env`, and the key pair as Cloudflare secrets — never in a
config file:

```bash
npx wrangler secret put VAPID_PUBLIC_KEY --config wrangler.jsonc
npx wrangler secret put VAPID_PRIVATE_KEY --config wrangler.jsonc
```

Generate a pair with `npm run vapid:keys` from a checkout of the repository. The
keys belong to this installation alone: replacing them invalidates every
subscription players have, and a Docker deployment of the same release has its
own. Secrets survive a deploy, so this is a one-time step.

## Upgrading and rolling back

Deploy a newer release the same way; the Games that are running keep running,
though every socket drops and the clients reconnect on their own.

Rolling **back** is only safe within the same **snapshot version**
(`MANHUNT_SNAPSHOT_VERSION` in `release.env`): a Game stored by a release with a
higher snapshot version cannot be read by an older one. Each release's notes say
which version it carries. Every Game is deleted within 24 h of being created
anyway, so waiting a day makes any rollback safe.

## Day to day

- `/health` reports `{ ok, version, protocol }` — the quickest check of what is
  deployed.
- Logs are in the dashboard under the Worker's **Logs** (Workers observability is
  enabled in the config). They carry errors, the lifecycle of each Game and
  rejected connections — never positions or player names.
- There is nothing to back up: a Game lives in its own Durable Object and is
  deleted when it ends, or 24 h after it was created at the latest.
- On the free plan, once a daily limit is used up requests fail until 00:00 UTC
  and the app says so plainly. A handful of private games a week stays well
  inside it.
