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
