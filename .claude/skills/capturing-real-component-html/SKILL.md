---
name: capturing-real-component-html
description: Use when redesigning, prototyping, or visually iterating on any component in src/view/ (the topbar, a widget card, the docs site, the plan graph), before writing new JSX/CSS from scratch or guessing at markup.
---

# Capturing real component HTML

## Overview

`dev/component-capture/capture.mjs` drives a real `dist/` build of the app
against a real Spark event log via Playwright and dumps every high-level UI
region as standalone HTML: real `outerHTML` plus the real compiled CSS the
page actually loaded. No screenshots, no hand-copied JSX. Starting a redesign
from one of these files means starting from the app's own markup, not an
approximation of it.

## When to use

Any task that starts a visual redesign, prototype, or mockup of something in
`src/view/`: topbar, a widget card, the suggested-improvements/clean-checks/
full-app-report sections, the plan graph, the docs site. Run this before
writing new JSX/CSS, not after.

## How

```
npm run capture-components -- <path-to-event-log> [--out DIR] [--port N] [--skip-build]
```

- Needs a real log: `../spark-log-examples/*.zstd` or anything in `examples/`.
- First run only: `npx playwright install chromium`.
- Rebuilds `dist/` (committed in this repo, not gitignored) and restores it
  via `git checkout`/`git clean` afterward, but only if `dist/` was clean
  going in. A dirty `dist/` is left alone with a warning; check `git status`
  on it after the run either way.
- Output lands in `dev/component-capture/output/<log-basename>/` (gitignored):
  `topbar.html`, `landing.html`, `docs-site.html`, `plan-graph/`,
  `all-recommendations/board.html` (the highest-impact callout + FixTheseFirst
  table), and one file per active/reference widget under
  `suggested-improvements/`, `full-app-report/` plus a `clean-checks/board.html`
  (the whole Clean checks table: its rows are plain `TableRow`s, not
  individual widget cards, so there's no per-row breakdown there).
  `manifest.json` in that dir lists what was written and what was skipped (and
  why: e.g. a widget that didn't render for this particular log).
- Reuse a prior run's output if one already exists for the log/branch you
  care about and looks current; rerun if `src/view/` has changed since.

Open the relevant `.html` file(s) directly in a browser as the starting
material for the redesign.
