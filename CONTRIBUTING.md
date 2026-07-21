# Contributing

Thanks for helping build Manhunt.

## Ground rules

- The repo is **public** — never commit secrets. Use `.env` (git-ignored) and `.env.example` for shape.
- Server is authoritative: never trust client input for game outcomes (catches, boundary, wins).
- Keep `docs/arc42.md` in sync with architectural changes.

## Workflow

1. Pick an open issue from the backlog.
2. Branch: `feat/<short-name>` or `fix/<short-name>`.
3. Open a PR referencing the issue (`Closes #NN`).

Common tasks are wrapped in the [`Makefile`](./Makefile) so you don't have to
remember commands — run `make` to list them (`make install`, `make dev`,
`make test`, `make e2e`, `make up`, …).

## Testing requirements

**Every feature must ship with both unit tests and end-to-end tests.** A PR that
adds or changes behaviour is not complete until:

- **Unit tests (Vitest)** cover the new logic — server behaviour in
  `server/**/*.test.ts`, client components/hooks in `client/src/**/*.test.tsx`.
- **End-to-end tests (Playwright)** cover the user-facing flow in
  `client/e2e/**/*.spec.ts`, exercised against the real server.

Run everything with `make test-all` (unit + e2e) before opening or updating a
PR; CI (`.github/workflows/ci.yml`) runs the same suites and must pass. Bug
fixes should add a regression test that fails without the fix. First-time e2e
setup: `make e2e-install`.

## Linting

Code and docs are linted with **ESLint** (JS/TS/JSX/TSX), **Stylelint** (CSS),
and **markdownlint** (Markdown). Run `make lint` (or `npm run lint`) before
pushing; `make lint-fix` auto-fixes what it can. CI runs `npm run lint` and it
must pass.

The server and client are written in **TypeScript**. The server runs `.ts`
directly via Node's native type stripping (no build step); the client is bundled
by Vite. Type-check both with `npm run typecheck` (also run in CI).

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

Maintainers tag `vX.Y.Z`; CI builds and pushes the image to GHCR.

## Code review

Pull requests are reviewed automatically by [CodeRabbit](https://coderabbit.ai). Config lives in `.coderabbit.yaml`. Trigger a re-review by commenting `@coderabbitai review`.

## Commit convention

This repo uses [Conventional Commits](https://www.conventionalcommits.org). Commit messages must match:

```text
<type>(<scope>): <subject>
```

- **types**: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`
- **scopes** (optional): `client`, `server`, `infra`, `ci`, `docs`, `deps`, `release`, `db`, `vouch`
- **breaking change**: add `!` after the type/scope, e.g. `feat(server)!: change ws contract`, and/or a `BREAKING CHANGE:` footer.

Examples:

```text
feat(server): add authoritative catch detection
fix(client): throttle watchPosition to the 5–10s cadence
docs: update arc42 deployment view
chore(deps): bump socket.io to 4.7.5
```

Enforcement is automatic: a husky `commit-msg` hook runs commitlint locally, and
the `commitlint` GitHub Action re-checks every commit on pull requests. Enable
the local hook once after cloning with `npm install` (the `prepare` script wires
up husky). Optionally use the template: `git config commit.template .gitmessage`.
