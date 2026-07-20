#!/usr/bin/env bash
# One-shot: create the PUBLIC GitHub repo, push this initial commit, and file
# the backlog issues. Requires the GitHub CLI, authenticated (`gh auth login`).
#
# Usage:
#   ./scripts/setup-github.sh <owner>/<repo>
#   e.g. ./scripts/setup-github.sh yourname/manhunt
set -euo pipefail

REPO="${1:?Usage: ./scripts/setup-github.sh <owner>/<repo>}"

# Point compose at the right image before the first push.
sed -i.bak "s#ghcr.io/OWNER/manhunt#ghcr.io/${REPO}#" compose.yml && rm -f compose.yml.bak

echo "==> Creating PUBLIC repo ${REPO} and pushing"
gh repo create "$REPO" --public --source=. --remote=origin --push

echo "==> Filing backlog issues"
./scripts/create-issues.sh

echo "==> Done."
echo "Next:"
echo "  - Make the GHCR package public (or add a pull token) so 'docker compose pull' works."
echo "  - git tag v0.1.0 && git push --tags   # triggers the release image build"
