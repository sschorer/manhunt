#!/usr/bin/env bash
# Generate a grouped changelog from Conventional Commits for a git range.
# Usage: scripts/changelog.sh <range>
#   e.g. scripts/changelog.sh v0.1.0..v0.2.0   (between tags)
#        scripts/changelog.sh v0.1.0           (first release: all history)
set -euo pipefail
RANGE="${1:-}"

commits() { git log --no-merges --pretty=format:'%s (%h)' ${RANGE:+$RANGE}; }

# Breaking changes first (type/scope followed by "!").
breaking=$(commits | grep -E '^[a-z]+(\([^)]+\))?!: ' || true)
if [ -n "$breaking" ]; then
  printf '### ⚠ Breaking changes\n\n'
  echo "$breaking" | sed -E 's/^[a-z]+(\([^)]+\))?!?: /- /'
  printf '\n'
fi

section() { # <title> <type-regex>
  local title="$1" types="$2" body
  body=$(commits | grep -E "^(${types})(\([^)]+\))?!?: " || true)
  [ -z "$body" ] && return 0
  printf '### %s\n\n' "$title"
  echo "$body" | sed -E "s/^(${types})(\([^)]+\))?!?: /- /"
  printf '\n'
}

section "Features"       "feat"
section "Bug fixes"      "fix"
section "Performance"    "perf"
section "Refactors"      "refactor"
section "Documentation"  "docs"
section "Build & CI"     "build|ci"
section "Other"          "chore|style|test|revert"
