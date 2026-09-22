# sparkforensics

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
