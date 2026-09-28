---
status: accepted
---

# Nothing in GitHub deploys to Cloudflare

The repository is public. We never deploy to Cloudflare from GitHub: no `wrangler deploy` in Actions, no Cloudflare API tokens in repository secrets, and no Cloudflare Workers Builds connected to this repository. GitHub releases publish a prebuilt Cloudflare release file with a config template free of account data, and deployers run its deploy script from their own machine with their own credentials.

## Consequences

- **Manual deploys:** a Cloudflare deploy is always a manual step after a release.
- **What CI can check:** CI verifies the release file under `wrangler dev` without an account, but can't verify a real Cloudflare deployment. It may also run `wrangler deploy --dry-run` against the release file's rendered config — that stops before it would need an account or upload anything, so it is not a deploy. Nothing else from the `deploy`/`versions` family is allowed, and `scripts/no-cloudflare-deploys.test.ts` fails when a workflow reaches for one.
- **Allowed in Actions:** GitHub Actions may still run CI, publish the GHCR image and create artifact attestations, because none of these touch Cloudflare.
