#!/bin/sh
# Fails a PR that changes packages/cli, packages/core, packages/mcp,
# packages/server, or the root site app without also adding a changeset.
# Run only on pull_request CI events (BASE_REF is the PR's target branch,
# e.g. "main").
set -e

BASE_REF="${1:-main}"
git fetch origin "$BASE_REF" --quiet

CHANGED=$(git diff --name-only "origin/${BASE_REF}...HEAD")

# Keep in sync with the PACKAGES const in scripts/publish-packages.mjs and the
# mcp-package-name check in .github/workflows/release.yml: those answer "what
# to actually publish", not "what requires a changeset" (core is vendored
# into cli/mcp at pack time, never published on its own; the root site
# package is never published at all, see .changeset/config.json's
# privatePackages.version), so don't merge the lists, just check all three
# when a new package is added.
TOUCHES_PUBLISHABLE=$(echo "$CHANGED" | grep -E '^packages/(cli|core|mcp|server)/' || true)

# The root site app: src/ and its top-level build config. Deliberately
# excludes docs-site/ -- that content ships inside the same dist/ but isn't
# an app-behavior change, matching how this gate already treats "in the
# shipped artifact" (docs-site) differently from "publishable/behavioral"
# (packages/core, vendored but gated above) elsewhere in this same check.
TOUCHES_SITE=$(echo "$CHANGED" | grep -E '^src/|^index\.html$|^vite\.config\.ts$|^package\.json$' || true)

if [ -z "$TOUCHES_PUBLISHABLE" ] && [ -z "$TOUCHES_SITE" ]; then
  echo "No changes under packages/cli, packages/core, packages/mcp, packages/server, or the root site app; no changeset required."
  exit 0
fi

HAS_CHANGESET=$(echo "$CHANGED" | grep -E '^\.changeset/[^/]+\.md$' | grep -vi '^\.changeset/README\.md$' || true)
if [ -z "$HAS_CHANGESET" ]; then
  echo "This PR touches a publishable package or the root site app but adds no .changeset/*.md file."
  echo "Run 'npx changeset add' and commit the result."
  exit 1
fi

echo "Changeset present, ok."
