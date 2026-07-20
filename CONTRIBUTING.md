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

## Releasing
Maintainers tag `vX.Y.Z`; CI builds and pushes the image to GHCR.

## Code review

Pull requests are reviewed automatically by [CodeRabbit](https://coderabbit.ai). Config lives in `.coderabbit.yaml`. Trigger a re-review by commenting `@coderabbitai review`.

## Commit convention

This repo uses [Conventional Commits](https://www.conventionalcommits.org). Commit messages must match:

```
<type>(<scope>): <subject>
```

- **types**: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`
- **scopes** (optional): `client`, `server`, `infra`, `ci`, `docs`, `deps`, `release`, `db`, `vouch`
- **breaking change**: add `!` after the type/scope, e.g. `feat(server)!: change ws contract`, and/or a `BREAKING CHANGE:` footer.

Examples:

```
feat(server): add authoritative catch detection
fix(client): throttle watchPosition to the 5–10s cadence
docs: update arc42 deployment view
chore(deps): bump socket.io to 4.7.5
```

Enforcement is automatic: a husky `commit-msg` hook runs commitlint locally, and
the `commitlint` GitHub Action re-checks every commit on pull requests. Enable
the local hook once after cloning with `npm install` (the `prepare` script wires
up husky). Optionally use the template: `git config commit.template .gitmessage`.
