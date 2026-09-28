# Contributing

Thanks for helping build Manhunt.

## Ground rules

- The repo is **public** — never commit secrets. Configuration is Worker variables and Cloudflare secrets, or `deploy/.env` (git-ignored; `deploy/.env.example` for shape).
- The Game is authoritative: never trust client input for game outcomes (Catches, Boundary, wins).
- **Web standards only** in the backend: no `node:` imports and no `nodejs_compat`. The game core (`server/game/`) additionally takes no `cloudflare:*` imports, so it stays testable in plain Vitest — ESLint enforces both.
- Keep `docs/arc42.md` in sync with architectural changes, and the domain glossary in `server/CONTEXT.md`.

## Workflow

1. Pick an open issue from the backlog.
2. Branch: `feat/<short-name>` or `fix/<short-name>`.
3. Open a PR referencing the issue (`Closes #NN`).

Common tasks are wrapped in the [`Makefile`](./Makefile) so you don't have to
remember commands — run `make` to list them (`make install`, `make dev`,
`make test`, `make e2e`, `make docker-dev`, …).

`make dev` runs the real Worker and its Durable Objects in local `workerd` behind
the Vite dev server, so development talks to exactly the backend production runs —
there is no second server to start.

## Testing requirements

**Every feature must ship with both unit tests and end-to-end tests.** A PR that
adds or changes behaviour is not complete until:

- **Unit tests (Vitest)** cover the new logic. Which runner depends on where the
  code sits:
  - the game core (`server/game/`), the push notification and endpoint modules
    (`server/push/`) and the wire protocol (`shared/`) are plain TypeScript, so
    they run in plain Vitest — `npm run test:server`, `npm run test:shared`;
  - the host modules that touch the platform (`server/worker.ts`,
    `server/rooms/`) are tested with `@cloudflare/vitest-plugin` in
    `**/*.workers.test.ts` — `npm run test:worker`. Durable Object **WebSocket**
    tests go in `**/*.ws.workers.test.ts`, which the serial `worker-serial`
    project runs with `--max-workers=1 --no-isolate`;
  - client components and hooks in `client/src/**/*.test.tsx`;
    - the tooling in `scripts/` — the release file, its deploy script and the
      release notes — also runs in plain Vitest: `npm run test:scripts`.
- **End-to-end tests (Playwright)** cover the user-facing flow in
  `client/e2e/**/*.spec.ts`, against the built Worker in local `workerd`.
  `client/e2e/harness.ts` starts it and sets `baseURL`; a spec that needs
  different Worker variables (a shorter Ping interval, Web Push on) sets them with
  `test.use({ workerVars: … })`.

Prefer a game-core test where the behaviour is a rule. Reach for a Worker test
only for what is genuinely a transport concern: the Seat cookie and `Origin`
check, socket replacement, alarms and hibernation, close codes, retention.

Run everything with `make test-all` (unit + e2e) before opening or updating a
PR; CI (`.github/workflows/ci.yml`) runs the same suites and must pass. Bug
fixes should add a regression test that fails without the fix. First-time e2e
setup: `make e2e-install`.

Changes to the self-hosted target (`deploy/`, `server/assets/`) also need
`make docker-e2e`, which builds the image and plays a real Game against it. CI
runs it too, in its own `docker` job. Changes to the Cloudflare release file
(`deploy/release/`, `scripts/cloudflare-release.ts`) need `make release-e2e`,
which packages the file and plays the same Game against it under `wrangler dev`.

Adding a Worker binding or route means touching every configuration that describes
the deployment: `deploy/wrangler.jsonc` (Cloudflare and local dev),
`deploy/config.capnp` (the image), and — for a variable an operator sets —
`deploy/release/wrangler.template.jsonc`, the `sed` list in
`deploy/release/deploy.sh` that fills it, and `deploy/release/.env.example`.
`server/deploy.test.ts` fails when any of them drifts from the others, including a
placeholder the deploy script doesn't fill or a setting the example doesn't
document.

## Linting

Code and docs are linted with **ESLint** (JS/TS/JSX/TSX), **Stylelint** (CSS),
and **markdownlint** (Markdown). Run `make lint` (or `npm run lint`) before
pushing; `make lint-fix` auto-fixes what it can. CI runs `npm run lint` and it
must pass.

The backend and client are written in **TypeScript**, and nothing is compiled
ahead of time: one Vite build produces both the PWA and the Worker bundle, and the
tooling in `scripts/` runs `.ts` directly via Node's native type stripping.
Type-check everything with `npm run typecheck` (also run in CI) — it runs `tsc`
three times, because the plain-TypeScript backend, the Workers backend and the
client each have their own config.

## Trust and vouching

Manhunt uses [vouch](https://github.com/mitchellh/vouch), the trust system Ghostty
uses. The list lives at [`.github/VOUCHED.td`](./.github/VOUCHED.td).

Every PR gets one label automatically:

| Label | Meaning |
| --- | --- |
| `vouch:trusted` | Collaborator, bot, or listed in `VOUCHED.td` |
| `vouch:unvouched` | Not yet listed. **Your PR is not rejected.** |
| `vouch:denounced` | Explicitly blocked |

**This gates nothing automatic.** Unvouched PRs are not closed, CI runs on them
normally, and they get reviewed. The label is a triage signal for maintainers —
trusted PRs get read first, `vouch:denounced` PRs are closed without review.

Maintainers vouch by commenting `vouch @handle` on any issue, which opens a PR
against `VOUCHED.td` — the trust list only changes through reviewed commits. To
denounce: `denounce @handle <reason>`; to remove: `unvouch @handle`. If your PR
is mislabelled after a list change, comment `/recheck-vouch`.

> This is a **contributor**-trust workflow. It is unrelated to any in-game
> access control.

## Releasing

Maintainers tag `vX.Y.Z` and push it; the `release` workflow builds the GHCR image
and the Cloudflare release file from that commit, plays a real Game against each of
them, and only then publishes the release with `SHA256SUMS` and artifact
attestations. **Nothing in GitHub deploys to Cloudflare**
([ADR-0008](./docs/adr/0008-no-cloudflare-deploys-from-github.md)): that deploy
happens from the deployer's own machine, with the release file's own `deploy.sh`.
The full procedure — both targets, VAPID keys, rollbacks — is in
[`docs/operations.md`](./docs/operations.md).

Two versions travel with a release and both matter to compatibility: the
**protocol version** in `shared/version.ts` (raised only for a breaking wire
change; an outdated client gets close code `4004` and reloads) and the **snapshot
version** a Game's stored state carries (upgraded in plain TypeScript inside
`restoreGame`). A release must keep loading the previous snapshot version for at
least 24 h, so a Game created before the deploy survives it. Both are in the
release notes, and rolling back is only safe to a release with the same snapshot
version.

## Code review

Pull requests are reviewed automatically by [CodeRabbit](https://coderabbit.ai). Config lives in `.coderabbit.yaml`. Trigger a re-review by commenting `@coderabbitai review`.

## Commit convention

This repo uses [Conventional Commits](https://www.conventionalcommits.org). Commit messages must match:

```text
<type>(<scope>): <subject>
```

- **types**: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`
- **scopes** (optional): `client`, `server`, `infra`, `ci`, `docs`, `deps`, `release`, `vouch`, `research`
- **breaking change**: add `!` after the type/scope, e.g. `feat(server)!: change ws contract`, and/or a `BREAKING CHANGE:` footer.

Examples:

```text
feat(server): add authoritative catch detection
fix(client): throttle watchPosition to the 5–10s cadence
docs: update arc42 deployment view
chore(deps): bump wrangler to 4.32.0
```

Enforcement is automatic: a husky `commit-msg` hook runs commitlint locally, and
the `commitlint` GitHub Action re-checks every commit on pull requests. Enable
the local hook once after cloning with `npm install` (the `prepare` script wires
up husky). Optionally use the template: `git config commit.template .gitmessage`.
