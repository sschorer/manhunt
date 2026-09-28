# Operating Manhunt

Everything after `git tag`: what a release contains, how each of the two targets is
deployed and upgraded, and what to do when something looks wrong. The
architecture behind it is in [`arc42.md`](./arc42.md); the decisions in
[`specs/cloudflare-and-docker-migration.md`](./specs/cloudflare-and-docker-migration.md).

Both targets run the **same Worker bundle** and have full feature parity. Each
installation has its own Games and its own VAPID keys, and nothing is shared
between them — a Cloudflare deployment and a Docker deployment are two separate
installations of the same release.

## What a release publishes

Pushing a `v*` tag runs [`.github/workflows/release.yml`](../.github/workflows/release.yml),
which builds both artifacts, plays a real Game against each of them, and only
then publishes anything:

| Artifact | What it is |
| --- | --- |
| `manhunt-cloudflare-vX.Y.Z.tar.gz` | The Cloudflare release file: the Worker bundle, the built PWA, a Wrangler config template with **no account id and no domain**, `deploy.sh`, `.env.example`, `release.env` and its own README. |
| `ghcr.io/sschorer/manhunt:X.Y.Z` | The self-hosted image: the same bundle on a pinned `workerd`. `:latest` moves only for a final release, never for a pre-release. |
| `SHA256SUMS` | The checksum of the release file, for `sha256sum --check`. |
| Attestations | GitHub artifact attestations for the release file and the image, verified with `gh attestation verify`. |

The release notes carry the changelog, the deploy commands for both targets, the
digest of the image that was pushed, and the two versions that decide compatibility
— see [Versions and compatibility](#versions-and-compatibility). When a release
moves the pinned `workerd`, they say so in as many words, because its on-disk
storage is experimental and a self-hosted deployment upgrades into it.

Two end-to-end checks run **before** anything is published, and either one failing
leaves the tag with no release and no image:

- `npm run test:release` unpacks the release file, lets its own `deploy.sh` render
  the Wrangler config, runs the bundle on `wrangler dev` and plays a Game against
  it — as close to a Cloudflare deployment as CI can get without an account.
- `npm run test:docker` plays the same Game against the image, then replaces the
  container and finds the Game still on the volume.

**Nothing in GitHub deploys to Cloudflare**
([ADR-0008](./adr/0008-no-cloudflare-deploys-from-github.md)): there is no
Cloudflare credential in this repository, no `wrangler deploy` in any workflow,
and no Workers Build connected to it. Every Cloudflare deploy is a manual step by
a deployer on their own machine.

## Cloudflare

### The first deploy

1. Make sure the hostname you want is in a zone whose **DNS Cloudflare manages**,
   and that the name itself is free — a Custom Domain replaces any record on it.
2. Download and verify the release file:

   ```bash
   gh release download vX.Y.Z --repo sschorer/manhunt \
     --pattern 'manhunt-cloudflare-*.tar.gz' --pattern SHA256SUMS
   sha256sum --check --ignore-missing SHA256SUMS
   gh attestation verify manhunt-cloudflare-vX.Y.Z.tar.gz --repo sschorer/manhunt
   ```

3. Unpack it, fill in `.env` (`CLOUDFLARE_ACCOUNT_ID`, `MANHUNT_DOMAIN`, and
   `VAPID_SUBJECT` if you want Web Push — it is a Worker variable, so it has to be
   in place before the deploy), and log in once with `npx wrangler login`.
4. Run `./deploy.sh`. It renders `wrangler.jsonc` from the template, deploys with
   the pinned `wrangler`, and then polls `https://<your domain>/health` until it
   reports that release's version. It exits non-zero if that never happens.
5. Put the VAPID key pair on the Worker that now exists — see
   [VAPID keys](#vapid-keys). Secrets take effect on their own, without another
   deploy.
6. Play one test Game on real phones: a Catch, a Ping reveal, a reconnect and a
   push notification.

`deploy.sh --config-only` renders the config and stops, which is the quickest way
to see exactly what a deploy would send.

### Upgrading

Download the newer release and run its own `deploy.sh`; each release file carries
the `wrangler` it was tested with. Secrets survive a deploy, so the VAPID keys are
set once. Every socket drops on deploy and the clients reconnect on their own; a
Game that is running keeps running.

### Day to day

- `/health` answers `{ ok, version, protocol }` — the quickest check of what is
  actually deployed.
- Logs are in the dashboard under the Worker's **Logs** (Workers observability is
  on in the config). They carry errors, the lifecycle of each Game and rejected
  connections with their close code — never positions or player names.
- There is nothing to back up: a Game lives in its own Durable Object and is
  deleted when it ends, or 24 h after it was created at the latest.
- **No usage monitoring.** Typical use is around 6 % of the free plan; a heavy day
  (4 Games × 2 h × 12 players) uses roughly 31 % of the Durable Object duration.
  Once a daily limit is used up, requests fail until 00:00 UTC and the client says
  so plainly.

## Docker

The self-hosted target lives in [`deploy/`](../deploy) and is driven from the
[`Makefile`](../Makefile). `README.md` covers running it; what matters when
operating it:

- **No backups.** The volume holds live Games only, each deleted within 24 h of
  being created. There is nothing on it worth restoring, and nothing in the
  project pretends otherwise.
- **`uniqueKey` in `config.capnp` must never change.** It names the directory
  under `/data/games` that every Game's SQLite file lives in; a new key orphans
  every stored Game.
- Updating is `make pull` then `make up`; `make health` reports `ok`, `version`
  and `protocol`, and `make logs` tails the stack. Pin `TAG` in `deploy/.env` to a
  release rather than tracking `latest`.
- Single instance by design. Every restart drops sockets, and clients reconnect
  and are handed a full snapshot.
- `workerd`'s on-disk Durable Object storage is **experimental**, so its version
  is pinned exactly (`WORKERD_VERSION` in the Dockerfile) and only ever changed
  through a release. The notes of a release that moves it carry a callout pointing
  at the `workerd` release notes; read those before updating.

## VAPID keys

Web Push is optional and stays off until a key pair **and** a real contact subject
are configured. Generate a pair from a checkout:

```bash
npm run vapid:keys      # prints VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY
```

| Target | Public and private key | Subject |
| --- | --- | --- |
| Cloudflare | `npx wrangler secret put VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`, against the rendered `wrangler.jsonc` | `VAPID_SUBJECT` in the release `.env`, written into the config by `deploy.sh` |
| Docker | `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` in `deploy/.env` | `VAPID_SUBJECT` in the same file |

On Cloudflare the subject is a Worker variable and the keys are secrets, which is
why they are set at different moments: the subject before the deploy that writes
it into the config, the keys after it, once there is a Worker to put a secret on.
Neither belongs in a config file or a repository, and each installation has its
own: a browser's subscription belongs to the origin it subscribed from.
Replacing a pair invalidates every subscription players have, so they have to opt
in again. `VAPID_SUBJECT` must be a real `mailto:` or `https:` URI the push
services can reach you at — without it, push stays off with a logged warning.

## Versions and compatibility

| Version | Where it lives | What it decides |
| --- | --- | --- |
| Release | the tag, baked into the build, reported by `/health` | which build is deployed |
| Wire protocol | [`shared/version.ts`](../shared/version.ts) | a client on an older protocol is closed with `4004` and reloads |
| Game snapshot | `SNAPSHOT_VERSION` in [`server/game/game.ts`](../server/game/game.ts) | whether a stored Game can still be read |

Both travel in every release's notes and in the release file's `release.env`.

**Rolling back** is only safe to a release with the **same snapshot version**: a
Game stored by a newer release cannot be read by one with a lower snapshot
version, and its players lose it. A release keeps loading the previous snapshot
version for at least 24 h, and every Game is deleted within 24 h of being created
— so a day after a deploy, any rollback is safe.

## Cutting a release

```bash
git tag v0.2.0 && git push --tags
```

That is the whole ritual; the workflow does the rest. Before tagging:

- `make test-all` and `make docker-e2e` are green on `master`.
- The commits since the last tag read well as a changelog — the notes are grouped
  from Conventional Commit types.
- If the snapshot version changed, the notes will say so; make sure the code still
  loads the previous version (see [`CONTRIBUTING.md`](../CONTRIBUTING.md)).

To rehearse the Cloudflare artifact locally, without tagging anything:

```bash
npm run build
npm run release:cloudflare      # dist-release/manhunt-cloudflare-<version>.tar.gz
npm run test:release            # the same check CI runs before publishing
```

A pre-release tag (anything with a hyphen, e.g. `v0.2.0-rc.1`) is marked as a
pre-release on GitHub and does not move the image's `:latest` tag.
