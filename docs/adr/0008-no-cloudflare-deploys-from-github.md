---
status: accepted
---

# Nothing in GitHub deploys to Cloudflare

The repository is public. We never deploy to Cloudflare from GitHub: no `wrangler deploy` in Actions, no Cloudflare API tokens in repository secrets, and no Cloudflare Workers Builds connected to this repository. GitHub releases publish a prebuilt Cloudflare release file with a config template free of account data, and deployers run its deploy script from their own machine with their own credentials.

## Consequences

- **Manual deploys:** a Cloudflare deploy is always a manual step after a release.
- **What CI can check:** CI verifies the release file under `wrangler dev` without an account, but can't verify a real Cloudflare deployment.
- **Allowed in Actions:** GitHub Actions may still run CI, publish the GHCR image and create artifact attestations, because none of these touch Cloudflare.
