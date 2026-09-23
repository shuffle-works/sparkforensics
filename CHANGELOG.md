# sparkforensics

## 0.24.4

### Patch Changes

- 816caec: Parser: SQL execution events no longer carry or retain `physicalPlanDescription` (Spark's text
  rendering of the plan, which nothing reads), and the raw `sparkPlanInfo` is released once its plan
  tree resolves. On a 3.5 GB decompressed real log this cut parse time 7.8% and peak RSS 21%, with
  identical findings.
  
  Estimates: `skew` and `straggler` recoverable time is no longer floored at the stage's current
  longest task, the very task their fix shortens. A stage gated by one straggler used to report
  about zero recoverable time, and could be dropped by the runtime floor. Their floor is now the
  longest task the fix leaves or the stage's core work over every core. Against a task-level
  replay of 765 flagged stages on 14 real logs, estimates more than 2x too low fell from 199 to 11.
  
  Estimates: low-GC `gc` findings (an over-provisioning signal) no longer claim the stage's GC time as
  recoverable wall-clock time, since their fix, less executor memory, raises GC rather than removing
  it. They are now informational and keep their `info` band.
  
  Estimates: `shuffle` and `spill` recoverable time now spreads the stage's shuffle-read or disk-spill
  bytes over every executor that ran it (one ~1 Gbps link or ~200 MB/s disk each) instead of pushing
  the whole cluster's bytes through a single link or disk. On the largest real log the old figures
  claimed 721 minutes of shuffle and spill savings on a 458-minute run; they now claim 51.
  
  Estimates: `tinyTask` recoverable time now uses the stage's own measured per-task overhead (task
  wall time minus executor run time) spread over the stage's achieved concurrency, instead of an
  assumed 50ms per task summed serially across tasks that ran in parallel.
  
  Estimates: `stageSlowness` no longer claims "stage duration minus 15 minutes" as recoverable. Its
  estimate is now what more partitions could recover: the time the stage's tasks were running, spread
  over the cores the stage left unused. A stage that sat queued with its one short task, or that
  already ran more tasks than the cluster had cores, no longer grades critical, and a long
  single-task stage that read data now does. One that read no input and no shuffle bytes claims
  nothing, since more partitions would have nothing to split. Stage messages carry a new `taskActiveMs`
  field for this.
  
  Parser: a stage whose `StageSubmitted` event carries no submission time (older Spark) now takes it
  from `StageCompleted`, instead of starting at epoch 0 and reading as a decades-long stage.
  
  Thresholds: `straggler` also fires on a 2.5-5% straggler share when the stage's recoverable tail
  already clears the 0.5% runtime floor. In a large stage, the few tasks that gate it for tens of
  seconds can be under 5% of its tasks.
  
  Parser: the NDJSON line splitter finds newlines in the decoded text instead of mapping raw-byte
  offsets to UTF-16 offsets, 4.4% faster parsing across 14 real logs with identical output.
  
  Analyzer: plan-shape fingerprints fold each child in as a fixed-length digest instead of its
  full fingerprint string, and scan classification rejects non-scan plan nodes before running its
  regexes and is computed once per node. `analyze()` is 40% faster across 14 real logs (1131ms to
  678ms; 729ms to 311ms on the largest), with identical findings. Join-detail normalization no
  longer rescans each identifier from every letter, another 8% (692ms to 636ms).
  
  Parser: a `physicalPlanDescription` value that spans decompressed chunks is dropped as raw bytes
  instead of being decoded and then cut out as text. Parsing the largest real log is 11.7% faster
  (12.56s to 11.09s) with peak memory down from 708MB to 602MB; 6.8% faster across 14 real logs,
  with identical output.
  
  Parser: a `TaskEnd` whose accumulator updates include a JSON array (Spark 2.x's
  `internal.metrics.updatedBlockStatuses`, or block-status tracking turned on) is no longer rejected
  and dropped from its stage's stats. Only the accumulable `ID` is validated now, which also makes
  parsing 3.7% faster across 14 real logs.
  
  Estimates: `duplicatePlanSubtree` claims only repeated work it can see. Repeats with the same
  shape but different filters, columns or tables are informational with low confidence. Each stage
  now counts only the repeated operators' share of it, and only for its task-active time, so a
  stage shared with a join or left waiting for cores no longer counts whole. Across 14 real logs,
  duplicate-subtree claims fell from 2307 to 108 minutes; before, three logs claimed more duplicate
  time than their whole run.
  
  Thresholds: `stageShape`'s under-parallelization rule skips stages shorter than 0.5% of the run,
  the same runtime floor the tiered detectors use: parallelizing a stage can't save more than its
  own duration. That was 2839 of 3005 such findings across 14 real logs.
  
  CLI and MCP: zstd event logs decompress with Node's native zlib zstd, one frame at a time, when
  the running Node has it (22.15+ or 23.8+); older Nodes and the browser keep the bundled decoder.
  Parsing the 14 real logs is 42% faster (22.3s to 13.0s; the largest log 10.7s to 6.4s) with
  identical output. Logs fetched from a Spark History Server take the same path (2.3s to 1.0s on
  a 566MB log).
  
  Estimates: `skew` and `straggler` count a tail of many slow tasks as their summed excess over
  the median spread across the stage's peak concurrent tasks, not just the longest task's excess.
  Against a task-level replay of 31 runs, estimates within 2x of the replay went from 56 of 78 to
  79 of 85, none are now more than 2x under (was 16), and skew recall rose from 0.60 to 0.73 with
  no loss of precision.
  
  Estimates and bands: `coldStart` measures the wait from the first stage to the first executor,
  not the driver's own startup before its first job. That removes 6 false positives on 14 real logs
  and 6 on the corpus, where executors were up long before the first stage. A `smallFiles` read
  spreads its per-file cost over the tasks that opened the files in parallel.
  
  Parsing: an adaptive query execution update that a later update for the same running SQL
  execution replaces is no longer parsed, since only the last plan is ever used. Parsing the 14
  real logs is 13% faster (13.1s to 11.3s; the largest log 6.3s to 5.4s) with identical findings.
  
  Parsing: large decompressed chunks are decoded in 512 KiB slices, so a SQL event's
  plan text is dropped undecoded even when one zstd frame holds all of it. On the largest real
  log that is 1.8 GB of text never decoded, and its parse is 13% faster (5.4s to 4.7s).
  
  Parsing: a task-end event's accumulator IDs are read without parsing the rest of each entry,
  which is 71% of those events' bytes. Parsing the 14 real logs is 11% faster (10.6s to 9.4s) and
  the 52 corpus logs 8% faster, with identical findings.
  
  Dashboard: zstd event logs decompress about 4x faster in the browser (the bundled decoder
  decodes every block into one reused buffer instead of allocating and shifting a window per frame
  and a buffer per block, and copies long runs natively), with byte-identical output on the 14 real
  logs. Decompressing the largest one in Chrome takes 2.9s instead of 11.6s.
  
  CLI and MCP: large zstd frames of a local event log decompress on Node's threadpool while the
  main thread parses. Parsing the 14 real logs is 14% faster (9.4s to 8.1s; the largest log 4.2s
  to 3.2s) with identical findings, for up to 139 MB more peak memory.
  
  Estimates: the `skew` and `straggler` core-work floor now leaves out the task time their fix
  removes. A stage whose stragglers were most of its core time was floored near its own duration:
  one real stage claimed 5.9s where a task-level replay recovers 38.7s. Against that replay over 65
  runs, estimates within 2x of it went from 88 of 95 to 97 of 103 and mean absolute error from
  7.55s to 5.18s; skew recall rose from 0.76 to 0.81 (precision 0.98 to 0.96).
  
  Estimates: a `straggler` claim runs from the stage's longest task down to the longest task the
  fix leaves (the longest one at or under 4x the median), not down to the median: a stage with a
  task just under 4x the median still waits on it. Stage messages carry a new
  `longestNonStragglerMs` field for this. Against the task-level replay over 65 runs, estimates
  more than 2x too high fell from 6 to 4 and mean absolute error from 5.18s to 4.49s. `skew` now
  takes the same floor. Before, a 100s stage whose next-longest task ran 39s had skew claiming 90s
  where straggler claimed 61s. Overestimates fell to 3. Mean absolute error fell to 4.12s.
  
  Parsing: an adaptive query execution update is recognized from the first and last pieces of its
  line as decoded, so an update that a later one replaces is no longer copied into one string only
  to be dropped. Parsing the 14 real logs is 3% faster (8.05s to 7.80s; the largest log 6%, 3.16s
  to 2.97s) with identical findings.
  
  Estimates: `retryWaste` no longer claims the summed time of its wasted attempts as wall-clock when
  those attempts ran side by side. When every wasted attempt is sampled, the claim is the longest
  retry chain (one task's repeated failures) times the mean wasted attempt, or the summed time spread
  over the stage's slots when larger. Four tasks lost with one executor on a real stage claimed
  146.6s and now claim 36.6s.
  
  Estimates: a `shuffle` claim can no longer exceed the shuffle fetch wait its tasks measured,
  converted to wall-clock at the stage's average concurrency. The per-link bandwidth model can't
  see whether reads stalled the tasks: on 14 real logs it claimed 2780s over 284 shuffle findings,
  and the capped figure is 256s. Five of the ten warning or critical shuffle findings had about
  zero fetch wait and are now informational.
  
  Thresholds: low-GC notes and `straggler` findings skip stages shorter than 0.5% of the run, the
  floor `stageShape` already uses. Every such straggler finding graded info, since a tail can't
  cost more than its stage's own duration, and a memory-sizing note from a stage that barely ran
  adds nothing. On 14 real logs that drops 464 low-GC notes and 671 straggler findings, all
  informational; high-GC, warning and critical findings are unchanged.
  
  Thresholds: `slowHost` and `tinyTask` skip stages shorter than 0.5% of the run too. A slow host or
  tiny tasks can't cost more than such a stage's own duration, so every finding there graded info.
  On 14 real logs that drops 324 slowHost and 132 tinyTask findings, all informational; warning and
  critical findings are unchanged.
  
  Thresholds: `shuffle` and `spill` findings skip stages shorter than 0.5% of the run as well. Their
  claims are clipped to the stage, so every such finding graded info. On 14 real logs that drops 182
  shuffle and 12 spill findings, all informational; warning and critical findings are unchanged.
  
  Thresholds: a `duplicatePlanSubtree` repeat whose stages together lasted less than 0.5% of the run
  is no longer reported. Its claim counts at most those stages' own time, so every such finding
  graded info. On 14 real logs that drops 340 of 545, all informational; warning and critical
  findings are unchanged.
- 8df894a: Finding docs links now open the section written for each finding: partition sizing, speculation
  waste, core locality, caching opportunity, cache utilization and autoscaling churn (which had no
  docs link before) each link to their own tuning-reference section instead of a shared parent
  page. Config audit tags link to the audited property's section when the tag stands for one
  property, instead of skipping the tuning reference. `get_finding_documentation` returns the owning
  chapter for autoscaling churn and cache utilization, whose sections live on a general chapter,
  instead of `tuningDoc: null`.
- fb33493: Tuning reference refreshed to spark-tuning-reference@1d0f90d: corrected detector threshold tables
  for failures, GC, shuffle, skew, small files, straggler, tiny tasks and utilization, and new
  sub-anchor sections for autoscaling churn (cluster config), cache utilization (memory model),
  speculation waste (straggler), partition sizing (shuffle), core locality and caching opportunity
  (utilization). The reference is now pinned to an exact upstream commit, recorded in the vendored
  docs as `upstream.json`.

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
