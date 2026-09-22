# sparkforensics-mcp

## 0.2.1

### Patch Changes

- 7719736: Add coverage collection to each package's vitest config and CI job, reporting to Coveralls.
- 5af79cd: Clarify two beginner-facing messages. The "not a Spark event log" parse error now says "no application-start event found" and points to the docs instead of naming the internal `SparkListenerApplicationStart` event class. The Scorecard's wall-clock and efficiency tiles spell out "No stage activity recorded" for a zero-activity run instead of chaining into the shared `—` "no value" glyph, which read as broken data rather than an empty run.
- 5af79cd: Topbar now carries a "New analysis" home button and a persistent Docs link once a run is loaded, since both previously existed only on the landing screen and there was no way back. Finding-type tags that link to a doc page now get a visible underline so they read as linkable at a glance instead of only on hover; `incompleteRun` (INCMP), which had no vendor doc anchor, now links to its SparkForensics guide entry instead of rendering as inert text. FixTheseFirst's grouped-row trailing stat ("×2 · 476ms recoverable") now carries a spelled-out tooltip explaining the shorthand.
- 5af79cd: The landing page now offers a "Try a sample run" option for visitors who don't have a Spark event log of their own. It loads a bundled, gzip-compressed real event log (picked by running the analyzer over every corpus candidate and taking the one with the most findings) so a first-time user can see the dashboard without hunting for their own data.
- ac586b2: Bump `react-dom` and `@types/react-dom` to 19.3.0, and `react` and `@types/react` to the matching `^19.3.0` so the peer-dependency ranges resolve without `--force`/`--legacy-peer-deps`.
- bbd90eb: Bump zod from 4.4.3 to 4.6.5.
- eb92d78: Exclude the vendored decompressors (fflate, fzstd) from packages/core's coverage report, matching the root config, and add tests for previously-uncovered core logic (finding-action-label, model-assembler, format-utils, parser-worker's multi-file error paths, ingest's worker-message routing). No runtime behavior change.
- 50c7b4b: Spell out "Estimated" instead of "Est." for the wall-clock impact prefix in the Markdown evidence report. The abbreviation only saved space in the web UI; the Markdown report now reads as a full phrase.
- 4981e0e: Vary confidence for eight more findings (skew, gc, straggler, speculationWaste, memoryUtilization's waste-model, coreLocality, autoscalingChurn, cachingOpportunity) with the strength of their underlying evidence instead of hardcoding `'low'`. Each now scales off that detector's own existing thresholds: skew and gc score how many multiples past their ratio/percentage floor a finding sits; straggler, speculationWaste, memoryUtilization and autoscalingChurn do the same against their own warn/critical tiers; coreLocality additionally weighs task-sample size, taking whichever signal is weaker; cachingOpportunity scales with how many executions repeat the same relation or plan shape past the minimum needed to fire at all.
- 91d197a: Vary confidence for the cacheUtilization and duplicatePlanSubtree findings with the strength of their underlying evidence instead of hardcoding `'medium'`. cacheUtilization's per-RDD cached/disk ratios now scale confidence with `numPartitions`: below 10 partitions a single partition flipping cached/evicted swings the reported percentage too much to trust (`low`), 50+ partitions makes the ratio stable (`high`). duplicatePlanSubtree's structural-fingerprint match (operator + metric names only, not literal values) now scales confidence with how far the matched subtree clears its own thresholds: a match at the bare minimum size and occurrence count is the case most likely to be coincidental (`low`), while a much bigger or more-repeated match is strong corroborating evidence (`high`).
- 0a8600d: Remove "unvalidated"/"unverified" hedging language from finding caveat text, the What-If Executor Scaling widget, and the design-spike confidence badge. The `confidence` field and its tooltip mechanism are unchanged; only the prose describing findings as uncalibrated against an external tool was reworded.
- 198b5c2: Run comparison's `confidence` field now also drops to `low` when matched stage coverage is below 50%, not just on an app-name mismatch, so two same-named runs that barely share any stages no longer report `ok`.
- a2e71e4: Bump vitest to 5.0.1 in packages/server and sync the root lockfile with it. Remove packages/server's own package-lock.json: as an npm-workspaces member, CI only ever installed from the root lockfile, so the nested one was dead weight that a directory-scoped Dependabot update could drift out of sync with (as this bump did, breaking `npm ci`). Dependabot's `/packages/server` entry is removed too, since the root entry already covers every workspace member's dependencies.

## 0.2.0

### Minor Changes

- 438e1b7: Bump to 0.2.0, rolling up the accumulated feature work since 0.1.0 (HTML
  export, run listing, widget catalog rework, and the other pending fixes)
  into one minor release across all three published packages.

### Patch Changes

- 438e1b7: Fix Executor Utilization and Memory Utilization overstating idle time and
  wasted-memory savings on runs with executor churn (spot preemption,
  `dynamicAllocation` replacement): both now measure real concurrent capacity
  instead of summing every executor that ever existed.
  
  `maxPartitionTooBig`, a hardcoded-critical OOM/crash-risk finding, no longer
  gets silently downgraded on long-running jobs by the generic wall-clock-based
  severity grading; it keeps its critical severity regardless of how small its
  modeled time savings are relative to the run.
  
  Cold Start and Executor Utilization no longer silently skip a run whose
  `startTime` is literally `0`.
  
  Task Skew and Straggler findings on the same stage now call out that they
  can describe the same wasted time and shouldn't be added together. Task
  Skew, Straggler, and GC Pressure now disclose that their thresholds are
  unvalidated, matching other findings with comparable uncertainty.
- 438e1b7: Executor Utilization and Memory Utilization no longer show a "no issues"
  card in the dashboard when they have zero findings; they now collapse into
  the Clean-checks row like every other widget instead of being always
  mounted. Core Usage by Locality keeps the always-mounted treatment.
  
  The CLI's `--format md/json` report and MCP's `diagnose_run` output change
  to match: when Executor or Memory Utilization has zero findings, it's now
  listed under "checked and clean" like every other detector, instead of
  being silently omitted from that section.
- 438e1b7: Add the `list_runs` MCP tool, which finds candidate Spark runs in a local
  directory or on a Spark History Server (by name pattern, date range, capped
  count) before diagnosing one with the other tools.
  
  `stageFailed` and `retryWaste` findings now carry up to 20 sampled
  failed/retried tasks each (task id, attempt number, host, executor, failure
  reason, peak executor memory, spill, shuffle write), instead of only a
  stage-level count. Redaction now walks every field literally named `host`
  anywhere in the findings tree, so these new samples get host-redacted too.
  
  Fix `compare_runs` stage matching under-reporting coverage: identities that
  collide the same number of times on both runs now pair off positionally
  instead of being dropped as ambiguous, and a stage's SQL identity is scoped
  to only the plan nodes that stage actually ran instead of the whole plan
  tree. Together these recover matched coverage on self-comparisons and on
  comparisons involving repeated stage shapes (e.g. a self-join's two Exchange
  stages).
  
  Rework the recommendation copy for slow-host and straggler findings so it no
  longer presumes a hardware fault by default, pointing at data locality and
  `spark.speculation` instead. Stage-slowness recommendation copy now points
  at shuffle-partition tuning. Fix the plan-node-detail parser so operators
  with no dedicated branch (e.g. `InMemoryTableScan`) no longer repeat their
  own name as a duplicate prefix in the parsed detail text.
- 438e1b7: Add a package README pointing at the main repo README, and make `--help`
  print usage instead of silently starting the server (mcp and server bins).
- 438e1b7: Speed up NDJSON event-log parsing ~4x (byte-scan line splitting, whole-chunk
  decode with substring lines). Make the server bin executable and serve nested
  directory-index requests.
- 438e1b7: Add the `get_reference_doc` MCP tool, which serves the Spark tuning reference
  by anchor. The reference is now sourced from the docs-site markdown chapters
  (single source) instead of vendored built HTML.
- 438e1b7: Register with the MCP Registry (adds `mcpName` and `.mcp/server.json`).
- 438e1b7: Rename the vendored Spark Tuning Reference's docs-config directory constant
  from `spark-doc` to `spark-tuning-reference`, matching the real upstream repo
  name and the hub's product-bar surface key.
- 438e1b7: Vendor upstream's per-chapter docs pages instead of a single monolithic
  page, memoize the detector-to-doc-anchor lookup, and single-source the
  bottleneck sub-anchor mapping between docs-config.ts and update-docs.mjs.
