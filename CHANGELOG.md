# sparkforensics

## 0.24.3

### Patch Changes

- 97732c9: Bump @base-ui/react from 1.6.0 to 1.8.0.
- 97732c9: Bump eslint from 10.8.0 to 10.11.0.
- 97732c9: Bump globals from 17.8.0 to 17.12.0.
- 97732c9: Bump js-yaml from 5.4.1 to 5.4.2.
- 97732c9: Bump jsdom from 30.1.0 to 30.1.1.
- 97732c9: Bump playwright from 1.62.1 to 1.63.0.
- 97732c9: Bump react-resizable-panels from 4.12.4 to 4.13.2.
- 97732c9: Bump tailwind-merge from 3.6.0 to 3.7.0.
- 97732c9: Bump @tanstack/react-table from 8.21.3 to 9.2.4. Migrates `StageTable`'s `useReactTable` call to v9's explicit `tableFeatures`/`useTable` API (row sorting, row pagination, and column visibility, the last needed for `row.getVisibleCells()`); no behavior change.
- 97732c9: Bump @testing-library/jest-dom from 6.9.1 to 7.0.1. No setup changes needed: the repo already registers matchers via the `@testing-library/jest-dom/vitest` subpath, and `@testing-library/dom` (now a required peer) is already satisfied transitively through `@testing-library/react`.
- 97732c9: Bump @testing-library/user-event from 14.6.1 to 14.6.7.
- 97732c9: Bump vite from 7.3.6 to 8.3.0. `@vitejs/plugin-react`, `@tailwindcss/vite`, and `vite-plugin-singlefile` all already declare Vite 8 support at their current pinned versions, so no plugin bumps were needed alongside it.
- 97732c9: Bump vitest and @vitest/coverage-v8 from 4.1.11 to 5.0.1 everywhere (root, packages/core, packages/cli, packages/mcp). This also collapses packages/server's own already-bumped `vitest@^5.0.1` back into a single hoisted install, since every workspace member now shares the same major version.
  
  Two config changes went with it: `vitest.config.js`'s `poolOptions.threads.{execArgv,maxThreads}` moved to the top-level `execArgv`/`maxWorkers` options per v5's pool-options rework, and `packages/core/vitest.config.js` now excludes `src/docs-content/**` from coverage: v5's coverage-v8 remaps uncovered files through Rolldown, which errored trying to parse that directory's markdown reference content as JS.
- 97732c9: Bump @xyflow/react from 12.11.3 to 12.11.6.
- 97732c9: Bump zustand from 5.0.14 to 5.0.15.
- d5b9987: `CachingOpportunity.tsx` now renders each finding's own confidence badge next to its row instead of a single shared low-confidence caveat below the table, matching the `cachingReuseConfidence` scaling the `cachingOpportunity` detector already applies per finding. Docs across `docs-content/detection` (`cache.md`, `chrn.md`, `local.md`, `mem.md`, `spec.md`) and `docs-site/contributor-guide/architecture` (`board-widgets.md`, `detector-contract.md`, `impact-estimation.md`, `state-and-history.md`, `widget-rendering.md`) now describe scaled `low`/`medium`/`high` confidence instead of a hardcoded value for `cachingOpportunity`, `autoscalingChurn`, `coreLocality`, and `memoryUtilization`'s waste-model, and `widget-rendering.md` drops `CachingOpportunity.tsx` from its confidence-exception list now that it's down to one named exception.
- 649ab3c: Fixed three CodeQL security alerts: the local server no longer interpolates
  the request method/URL into a `console.error` format string (a malformed
  request could otherwise corrupt the logged message); the static-file server's
  path-traversal guard now resolves the request path with `path.resolve`
  instead of `path.normalize`/`path.join`, matching the pattern CodeQL
  recognizes as sound; and the docs-site copy step's regex-escaping helper now
  escapes every regex metacharacter, not only `/`, when building the pattern
  used to rewrite absolute `/docs/...` references.
- 5cb0779: The landing page now probes for a reachable local Spark History Server (an empty `fetch(/shs-proxy)` that returns 400 when a server is present, versus a network error or 404 on a static deploy) and, when one responds, shows a neutral callout above "Other sources" pointing the user at the disclosure to fetch a run from it directly. The disclosure itself still doesn't move or auto-expand, and nothing renders until the probe resolves, so a static deploy with no server sees no change.
  
  The "Fetch from Spark History Server" and "Other sources" toggles now show a chevron that flips between down and up as each opens and closes, instead of only changing `aria-expanded` with no visual difference. The Base URL, Application ID, and Attempt ID fields also remember their last values across visits, so a returning user isn't retyping them.

## 0.24.2

### Patch Changes

- 7719736: Add coverage collection to each package's vitest config and CI job, reporting to Coveralls.
- 5af79cd: Clarify two beginner-facing messages. The "not a Spark event log" parse error now says "no application-start event found" and points to the docs instead of naming the internal `SparkListenerApplicationStart` event class. The Scorecard's wall-clock and efficiency tiles spell out "No stage activity recorded" for a zero-activity run instead of chaining into the shared `—` "no value" glyph, which read as broken data rather than an empty run.
- 5af79cd: Topbar now carries a "New analysis" home button and a persistent Docs link once a run is loaded, since both previously existed only on the landing screen and there was no way back. Finding-type tags that link to a doc page now get a visible underline so they read as linkable at a glance instead of only on hover; `incompleteRun` (INCMP), which had no vendor doc anchor, now links to its SparkForensics guide entry instead of rendering as inert text. FixTheseFirst's grouped-row trailing stat ("×2 · 476ms recoverable") now carries a spelled-out tooltip explaining the shorthand.
- 5af79cd: The landing page now offers a "Try a sample run" option for visitors who don't have a Spark event log of their own. It loads a bundled, gzip-compressed real event log (picked by running the analyzer over every corpus candidate and taking the one with the most findings) so a first-time user can see the dashboard without hunting for their own data.
- fc699ea: Bump @changesets/cli from 3.0.2 to 3.0.3.
- ff19377: Bump jsdom from 29.1.1 to 30.1.0.
- 04fc30d: Bump lucide-react from 1.24.0 to 1.47.0.
- ac586b2: Bump `react-dom` and `@types/react-dom` to 19.3.0, and `react` and `@types/react` to the matching `^19.3.0` so the peer-dependency ranges resolve without `--force`/`--legacy-peer-deps`.
- 02e13a5: Bump react-resizable-panels from 4.12.2 to 4.12.4.
- 6315cb4: Bump shadcn from 4.13.0 to 4.21.0.
- a9d17c2: Bump sonner from 2.0.7 to 2.0.8.
- ad1320b: Bump @testing-library/react from 16.3.2 to 16.3.3.
- 2158a9a: Bump @types/node from 22.20.1 to 26.6.2.
- bbd90eb: Bump zod from 4.4.3 to 4.6.5.
- eb92d78: Exclude the vendored decompressors (fflate, fzstd) from packages/core's coverage report, matching the root config, and add tests for previously-uncovered core logic (finding-action-label, model-assembler, format-utils, parser-worker's multi-file error paths, ingest's worker-message routing). No runtime behavior change.
- 50c7b4b: Spell out "Estimated" instead of "Est." for the wall-clock impact prefix in the Markdown evidence report. The abbreviation only saved space in the web UI; the Markdown report now reads as a full phrase.
- 4981e0e: Vary confidence for eight more findings (skew, gc, straggler, speculationWaste, memoryUtilization's waste-model, coreLocality, autoscalingChurn, cachingOpportunity) with the strength of their underlying evidence instead of hardcoding `'low'`. Each now scales off that detector's own existing thresholds: skew and gc score how many multiples past their ratio/percentage floor a finding sits; straggler, speculationWaste, memoryUtilization and autoscalingChurn do the same against their own warn/critical tiers; coreLocality additionally weighs task-sample size, taking whichever signal is weaker; cachingOpportunity scales with how many executions repeat the same relation or plan shape past the minimum needed to fire at all.
- 91d197a: Vary confidence for the cacheUtilization and duplicatePlanSubtree findings with the strength of their underlying evidence instead of hardcoding `'medium'`. cacheUtilization's per-RDD cached/disk ratios now scale confidence with `numPartitions`: below 10 partitions a single partition flipping cached/evicted swings the reported percentage too much to trust (`low`), 50+ partitions makes the ratio stable (`high`). duplicatePlanSubtree's structural-fingerprint match (operator + metric names only, not literal values) now scales confidence with how far the matched subtree clears its own thresholds: a match at the bare minimum size and occurrence count is the case most likely to be coincidental (`low`), while a much bigger or more-repeated match is strong corroborating evidence (`high`).
- 0a8600d: Remove "unvalidated"/"unverified" hedging language from finding caveat text, the What-If Executor Scaling widget, and the design-spike confidence badge. The `confidence` field and its tooltip mechanism are unchanged; only the prose describing findings as uncalibrated against an external tool was reworded.
- 198b5c2: Run comparison's `confidence` field now also drops to `low` when matched stage coverage is below 50%, not just on an app-name mismatch, so two same-named runs that barely share any stages no longer report `ok`.
- a2e71e4: Bump vitest to 5.0.1 in packages/server and sync the root lockfile with it. Remove packages/server's own package-lock.json: as an npm-workspaces member, CI only ever installed from the root lockfile, so the nested one was dead weight that a directory-scoped Dependabot update could drift out of sync with (as this bump did, breaking `npm ci`). Dependabot's `/packages/server` entry is removed too, since the root entry already covers every workspace member's dependencies.

## 0.24.1

### Patch Changes

- 6eb445d: Show the site's version in the keyboard shortcuts dialog.
