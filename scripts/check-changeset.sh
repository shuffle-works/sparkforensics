#!/bin/sh
# Fails a PR that changes packages/cli, packages/core, packages/mcp, or
# packages/server without also adding a changeset. Run only on pull_request
# CI events (BASE_REF is the PR's target branch, e.g. "main").
set -e

BASE_REF="${1:-main}"
git fetch origin "$BASE_REF" --quiet

CHANGED=$(git diff --name-only "origin/${BASE_REF}...HEAD")

# Keep in sync with the PACKAGES const in scripts/publish-packages.mjs and the
# mcp-package-name check in .github/workflows/release.yml: those answer "what
# to actually publish", not "what requires a changeset" (core is vendored
# into cli/mcp at pack time, never published on its own), so don't merge the
# lists, just check all three when a new package is added.
TOUCHES_PUBLISHABLE=$(echo "$CHANGED" | grep -E '^packages/(cli|core|mcp|server)/' || true)
if [ -z "$TOUCHES_PUBLISHABLE" ]; then
  echo "No changes under packages/cli, packages/core, packages/mcp, or packages/server; no changeset required."
  exit 0
fi

HAS_CHANGESET=$(echo "$CHANGED" | grep -E '^\.changeset/[^/]+\.md$' | grep -vi '^\.changeset/README\.md$' || true)
if [ -z "$HAS_CHANGESET" ]; then
  echo "This PR touches a publishable package but adds no .changeset/*.md file."
  echo "Run 'npx changeset add' and commit the result."
  exit 1
fi

echo "Changeset present, ok."
