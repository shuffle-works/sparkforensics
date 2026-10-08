# Evidence report and finding identity

The portable evidence report and the stable identity every finding carries.

## Portable evidence report

`packages/core/src/evidence-report.ts`'s `buildEvidenceReport(appModel, { redact })` returns
`{ markdown, json }`: a self-contained, byte-stable document that runs the
detectors over an `appModel` and serializes the result for sharing outside the
tool. Raw task records are never included; identifier redaction (app id + host
names → `app-1`/`host-1` pseudonyms via `packages/core/src/redact.ts`, with the app name
and `spark.app.name` replaced by the app id's pseudonym) is opt-in with
`{ redact: true }`. The JSON is pinned by `EVIDENCE_SCHEMA_VERSION`
(`packages/core/src/evidence-report.ts`, surfaced as `json.schemaVersion`) and has this fixed top-level key order:

```text
schemaVersion, summary, verdict, evidenceAvailability, detectors, findings, writeTargets, recommendations, cleanChecks, notRunChecks
```

- `summary` is the run header: `{ app: { id, name, sparkVersion }, stageCount,
  jobCount, sqlExecutionCount, findingCount, impactBandCounts,
  actionableFindingCount, actionableImpactBandCounts, clean, outcome, runShape }`. `findingCount`
  counts every row in `findings`; the `actionable*` counts leave out evidence
  caveats and the `incompleteRun` row, the same set the dashboard's top bar and
  verdict count. `clean` is `isCleanRun` from `packages/core/src/check-coverage.ts`, and
  `outcome` is `{ failedJobs, totalJobs, failureReason, failureReasonStageId }` from
  `summarizeRunOutcome` (`packages/core/src/run-outcome.ts`), the job results the dashboard
  verdict leads with; the Markdown prints it as an `- Outcome:` header line. `runShape`
  (`computeRunShape`, `packages/core/src/run-shape.ts`) is the Scorecard's wall-clock,
  Efficiency and Unused core time, the ETL phases' summed stage time and Core Usage by
  Locality's peak busy cores, each `null` where the dashboard shows none; MCP
  `get_run_summary` returns it too.
- `verdict` is the dashboard's run verdict from `buildRunVerdict`
  (`packages/core/src/run-verdict.ts`): `{ title, summary, steps, remainingPlaces, copyText }`.
  `steps` holds the first three places to look in the verdict card's order, each
  `{ key, stageId, type, tag, leadFindingId, actionLabel, recommendation, impact, impactMeaning,
  relatedTypes, text }`, where `text` is that step's line of the "Copy next steps" checklist and
  `copyText` is the whole checklist. The Markdown opens with it as `## Verdict`. The
  `recommendations` rollup stays alongside: it ranks fix types, the verdict ranks places.
- `evidenceAvailability` is the ledger above (or `null` when absent).
- `detectors` is `detectorCatalog()` output: one `{ type, version, scope,
  thresholds, docAnchor }` per detector, in `DETECTORS` order, so the exact
  threshold set that produced each finding travels with the evidence. On a
  tuned run (see the tuned-run paragraph below) a tuned row's
  `thresholds` are the ones the run used, plus `tunedThresholds`.
- `findings` are deterministically sorted rows (impact band → type → stage → id),
  each with a stable `id`, `tag`, core columns, an always-present `actionLabel`,
  and an `evidence` sub-object holding that finding type's declared evidence
  fields (see the per-type evidence paragraph below); `confidence`/
  `validationRequired`/`docAnchor` appear only when the detector emitted them.
- `writeTargets` is `extractWriteTargets` output (`packages/core/src/write-targets.ts`): every
  SQL write command with its path or table. The field contract is in the user guide's
  [Write targets](../../../user-guide/getting-started/ci-and-automation.md#write-targets).
- `recommendations` is the impact-ranked `buildRecommendationRollup` output
  (`packages/core/src/recommendation-rollup.ts`), and `cleanChecks` lists every detector type
  that fired zero findings this run and could run: see the rollup and clean-checks paragraph below.
- `notRunChecks` lists the zero-finding types the log lacked the data to run, each with a
  `reason`: see the not-run checks paragraph below.

Determinism holds because detector order, finding sort, and object key order
are all fixed, so a given `appModel` serializes identically across calls.

Redaction enumerates hosts two ways: by walking the findings tree for every
string value under a key literally named `host` (`evidence.host`,
`evidence.failedTaskDetails[].host`, `evidence.retriedTaskDetails[].host`,
and any nested `host` field, all covered without enumerating paths),
and by scanning every string value for EC2-style hostnames / bare IPv4
tokens. So identifiers that surface only in free text (recommendation copy, a
`stageFailed` failure reason in `valueText`) are pseudonymized too. Pseudonym numbering
uses a numeric-aware sort, so re-redacting an already-redacted report is a
no-op even past `host-10`.

Failed-task error text is dropped rather than pseudonymized, since a message
or stack trace can carry file paths and data values that no host pattern
matches: every array under a key named `failureGroups` has its `message`
replaced and the message text stripped from its `stackExcerpt`
(`redactTaskFailureGroup` in `task-failure.ts`). That covers the evidence
report and both the findings and the stage records of the HTML export.
A stage's failure reason is replaced outright with `[redacted]` wherever it
appears: a `stageFailed` finding's `valueText`, a stage record's
`stageFailureReason`, a job's `exception` and the report's `failureReason`
(`redactStageFailureReasons` in `redact.ts`).

The Markdown rendering mirrors the JSON's field set: each finding block
prints its `detector version`, its sorted `evidence` entries (byte-magnitude
keys humanized), and the report ends with a `## Detectors` catalog carrying the
version + threshold set. A finding's `impactEstimate` prints as its own `- impact: ` line
worded as the dashboard's "Potential savings": the wall-clock range, or the raw
waste only when there is no range, followed by what it counts ("of run time", "of
unused executor memory") and `estimateMethod`, and nothing for an informational or
zero estimate. A `- estimate: ` line carries the Advanced view's provenance sentence
(`estimateProvenance`). Both come from `packages/core/src/impact-format.ts`, the
formatters every dashboard surface uses, so memory reads in GB-h from 0.1 GB-h up,
core time in core-s or core-h, and a time figure has no "Estimated" prefix. JSON finding
rows carry the same figure as `impact`/`impactMeaning` when there is one, and each
`recommendations` row an `impactMeaning` next to its `impact`, which is null for a
resource figure that rounds to zero. `EvidenceExport` names downloads
`evidence-<appId>[-redacted].<md|json|html>`, taking the app id from the (already
pseudonymized when redacting) report so a redacted file never leaks the real id
and is never name-identical to a raw export.

A finding row carries `impactEstimate` when the finding has one, with the full contract
documented in [Impact estimation](../impact-estimation.md#occupancy-weighted-attribution)
(basis, wallClock, estimateMethod, rawWaste, coreTimeMs, and on `utilization` idleCoreTimeMs). It appears after the pinned core
columns (`id`, `type`, `impactBand`, `stageId`, `metric`, `value`, `recommendation`, `detectorVersion`, plus
optional but pinned `confidence`, `validationRequired`, `docAnchor`) without displacing any of
them. The full row shape is `FindingRowColumns` in `evidence-report.ts`, which also carries
`name`, `tag`, `valueText`, `remediation`, `actionLabel`, `impact`/`impactMeaning` and, on a tuned run,
`tunedThresholds`.

The report carries the same recommendation data the dashboard's "Fix These First" view shows,
so the CLI (`packages/cli/bin/sparkforensics-analyze.mjs`) and the MCP tool (`diagnoseRun` in
`packages/core/src/mcp-tools.ts`) get it too, not just the web markdown/JSON download.
`FindingRow.actionLabel` is always present (a short imperative label like "Reduce shuffle
size"), from `findingActionLabel` (`packages/core/src/finding-action-label.ts`), which reads the
type's `actionLabel` in `finding-presentation.ts` and falls back to the type's name. The
dashboard, the run verdict and the report rows all call it.
`EvidenceReportJson.recommendations` is the same impact-ranked
`buildRecommendationRollup` grouping (`packages/core/src/recommendation-rollup.ts`) that
`FixTheseFirst.tsx` renders, so CLI/MCP/download consumers get the same "what's the
highest-impact fix" ranking the dashboard shows, without changing the `findings` array's own
impact-band-sorted order at all. `EvidenceReportJson.cleanChecks` lists every
detector type that fired zero findings this run, each with `getThresholdSummary`'s one-line
"what would have tripped it" sentence; unlike the dashboard's `Alerts.tsx` clean-checks table,
it deliberately includes the one "always-mounted" reference type (`coreLocality`) even when it
has no findings, since a flat evidence report has no separate always-visible surface for it to
already appear on the way that widget does on the board.

A check the log could not run is not listed as clean.
`packages/core/src/check-coverage.ts` holds the one rule, shared with the dashboard's verdict,
top bar and Clean checks: a type whose only finding is an evidence caveat, every `scope: 'stage'`
type on a log where no stage recorded an end, and the run-span types (`utilization`,
`memoryUtilization`, `autoscalingChurn`) on a log with no ApplicationEnd. Those types are listed
in `notRunChecks` instead of `cleanChecks`, each `{ type, tag, thresholdSummary, reason }`, where
`reason` is the caveat's own recommendation (it names the setting to turn on) or the log-wide
sentence. The Markdown has a `## Not checked on this log` section above `## Clean checks`, and a
`Findings to act on` header line.

`Finding` is a union discriminated on `type`, one member per emitted
finding type (`packages/core/src/finding-types.ts`), and a finding row's `evidence` is an
explicit per-type projection. Each type's `<Type>Evidence` interface names its public fields,
and `EVIDENCE_KEYS` in `evidence-report.ts` lists the same keys, checked both ways at compile
time, so a field a detector adds only for another core module does not become report contract.
Rows leave out these fields: `stageShape`'s `totalCores`; `utilization`'s `utilizationFraction`,
`appDurationMs`, `totalCores` and `allocatedCoreMs`; `memoryUtilization`'s `idleRateFraction`, `allocatedMBSeconds`, `allocatedMB`,
`peakExecutors`, `appDurationMs` and `allocatedBytes`; `retryWaste`'s `extended` display copy.
The impact estimator reads them on the finding. `value` is always numeric or `null`: the
text-valued findings (`stageFailed`'s failure reason, `configAudit`'s current setting,
`incompleteRun`'s `missing`) carry their text in a `valueText` column, present only on those
rows, and the Markdown prints it where `value` would go. Renaming or removing an evidence field
is a breaking change and needs a schema bump. `cleanChecks`/`notRunChecks` list emitted finding
types, the set the dashboard's Clean checks shows: `overBroadcast` and `underBroadcast` in place
of the `broadcastSizing` detector entry. A finding row's `actionLabel` for a (type, discriminant)
combination with no label of its own is the type's name, the same fallback the verdict step
uses.

`buildEvidenceReport(appModel, { thresholds })` runs the detectors
with a user's validated overrides (the CLI's and MCP server's `--thresholds`; see
[Tuning thresholds](../detector-contract.md#tuning-thresholds)). Only a tuned run adds keys:
`tunedThresholds` (`{ <name>: { value, default } }`) on each finding row and each
`cleanChecks`/`notRunChecks` entry from a detector an override moved off its defaults (or
whose `suppressedBy` or threshold-source detector it moved), on that detector's `detectors` row, and as `summary.tunedThresholds` keyed by detector type. The
Markdown adds a `- Tuned thresholds:` header line, a `- tuned thresholds:` line per affected
finding, and marks tuned catalog rows and clean checks. A default run's report carries none of
these keys, and every one is optional. The report caches key on the overrides object as well as
the `appModel`, so one model's default and tuned reports never mix. Finding ids ignore
thresholds: a finding a tuned run still emits keeps the id it has in a default run.

## Finding identity

Every finding `analyzer.ts` emits carries a stable `id` (`push()`'s
`findingId()` choke point, FNV-1a hash over `type | location | metric |
value | discriminators`) and a `detectorVersion` (from the emitting `DETECTORS`
entry). The two are deliberately decoupled: `id` is derived only from a
finding's evidence tuple, never from `detectorVersion`, so a threshold or
logic tweak that bumps a detector's `version` does not change the `id` of
findings it still emits at the same location/metric. A saved reference
(dashboard bookmark, exported report row) keeps
pointing at the same logical finding across detector revisions;
`detectorVersion` is separate provenance metadata for "which ruleset
produced this," not part of identity. See
`packages/core/test/analyzer-finding-identity.test.js` for the decoupling proof.

The discriminators are declared per finding type (`ID_DISCRIMINATORS` in
`analyzer.ts`, each key checked against that type's fields) and joined in the
fixed `DISCRIMINATOR_SLOTS` order, and the value slot takes `value`, else
`valueText`.

`id` stability holds for equivalent reruns of the same schema/analyzer
version on the same input. Changing the id-derivation rule itself (the hash
algorithm, or which fields feed the location key/discriminators) is an
intentional breaking change and must bump `EVIDENCE_SCHEMA_VERSION`
(`packages/core/src/evidence-report.ts`); there is no separate id-scheme version.
