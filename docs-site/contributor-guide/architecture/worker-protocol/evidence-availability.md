# Evidence availability

How the parser records which evidence a log contained, and the shared taxonomy that reports it.

## Evidence-availability worker input

`packages/core/src/event-handlers.ts`'s `createState()`/per-event handlers start and
increment this fixed `evidenceInputs` shape on the normalized app model:

```text
environmentUpdates, applicationEnds, stageSubmissions, rddStorageSnapshots,
sqlExecutions, resolvedSqlPlans, executorMetricRows, taskRecords
```

The counters are a structured-clone-safe summary: they contain counts, not raw
events, task records, host names, SQL text, paths, or Spark-property values. The final `app` message snapshots the counters after all input is
processed, immediately before `done`; a consumer must not add a second worker
message just for the ledger. `app` messages are also emitted mid-parse from
`SparkListenerApplicationStart`, `SparkListenerApplicationEnd`, and a
`SparkListenerEnvironmentUpdate` that arrives after the start; those
snapshots are partial and non-authoritative. Only the terminal `app` message
emitted by `emitParseCompletion` (the one immediately before `done`) should be
used for evidence-availability conclusions. On the main thread, `useIngest`
combines the normalized `AppModel` with `done.skippedLines`, derives the ledger
before calling `analyze()`, and stores it as `appModel.evidenceAvailability`.

## Evidence-availability contract

`packages/core/src/evidence-availability.ts` is the single reusable taxonomy for the
browser, the evidence report, and the headless CLI and MCP consumers. Its serialized
ledger shape is `{ schemaVersion: 1, entries: EvidenceAvailabilityEntry[] }`.
Entries are ordered by the following fixed eight-key enum:

```text
executorMetrics, rddStorageSnapshots, sqlPlan, sparkConfiguration,
taskCoreTime, infrastructureContext, sourceContext, costContext
```

Each entry has the stable fields `key`, `state`, `reasonCode`, `summary`, and
optional `evidence`. The closed state enum is:

```text
present, disabled, notEmitted, notApplicable, outsideEventLog, unknown
```

The closed reason-code enum is:

```text
observed, explicitlyDisabled, noObservedExecutorMetrics,
noObservedStageSubmission, noRddStorageSnapshot, noResolvedSqlPlan,
noSqlExecution, noEnvironmentUpdate, noTaskRecords, noUsableCoreTimeAggregate,
outsideEventLogScope, parseIncomplete
```

`summary` is domain-agnostic presentation copy derived from the reason code;
the enum values, not labels, are the machine contract. Optional `evidence` is
limited to safe compact provenance of the exact `{ eventType, count }` shape.
`eventType` values are pinned to the exact `evidenceInputs` counter keys; they
are not shortened or aliased.
It must never include raw Spark-property values, host names, paths, SQL text,
task records, raw-event identifiers, or other event payloads.

| Key | Proven `present` evidence | Trustworthy absence / boundary result |
| --- | --- | --- |
| `executorMetrics` | `executorMetricRows > 0`, counting stage executor metrics rows and task ends with a non-zero executor metric | Explicit observed `spark.eventLog.logStageExecutorMetrics=false` is `disabled` / `explicitlyDisabled`; otherwise `notEmitted` / `noObservedExecutorMetrics`. Observed metrics win over the explicit setting. |
| `rddStorageSnapshots` | `rddStorageSnapshots > 0` from `SparkListenerStageSubmitted` | No stage submissions is `notEmitted` / `noObservedStageSubmission`; stages submitted without any `RDD Info` rows is `notEmitted` / `noRddStorageSnapshot`. This is RDD snapshot evidence, not block-update telemetry. |
| `sqlPlan` | `resolvedSqlPlans > 0` | A SQL execution without a resolved plan is `notEmitted` / `noResolvedSqlPlan`; no SQL execution is `notApplicable` / `noSqlExecution`. |
| `sparkConfiguration` | `environmentUpdates > 0` | `notEmitted` / `noEnvironmentUpdate`; a normalized empty config object alone is not evidence. |
| `taskCoreTime` | `taskRecords > 0` and a usable `runAggregates.perStage` task count | No task records is `notEmitted` / `noTaskRecords`; task records with no usable aggregate are `notEmitted` / `noUsableCoreTimeAggregate`. An empty aggregate object is not usable evidence. |
| `infrastructureContext` | none | Always `outsideEventLog` / `outsideEventLogScope`. |
| `sourceContext` | none | Always `outsideEventLog` / `outsideEventLogScope`. |
| `costContext` | none | Always `outsideEventLog` / `outsideEventLogScope`. |

Parse integrity is fail-closed. A parse is trustworthy only when it skipped no
malformed lines and observed an application-end event. For an untrustworthy
parse, proof already observed remains `present`, and an explicitly observed
executor-metrics disablement remains `disabled`; every conclusion based on
absence or irrelevance becomes `unknown` / `parseIncomplete`. The three
outside-event-log product boundaries remain `outsideEventLog`. In particular,
`notEmitted` and `notApplicable` are never favorable measurements inferred
from an incomplete parse.

Availability is model metadata, not a detector or finding: it never changes
detector thresholds or ordering, impact band, catalog/scorecard counts,
no-bottleneck behavior, or detector suppression. `session-snapshot.ts`
captures and restores `evidenceAvailability` with the normalized model, so a
recent-file switch retains the same ledger without reparsing.
