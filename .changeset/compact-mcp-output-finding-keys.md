---
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-web": minor
---

The MCP `diagnose_run` answer is compact by default, and every finding has a key that matches across reruns. **Default change for MCP clients:** `diagnose_run` returns `view: "compact"`, which lists one short row per finding (`id`, `key`, `type`, `tag`, `name`, `impactBand`, `stageId`, `actionLabel`, `metric`, `value`, and the savings figure) and leaves out `cleanChecks`, `notRunChecks` and each finding's evidence, remediation and estimate. The verdict, `recommendations`, `metrics`, `writeTargets` and `effectiveConf` stay. On the bundled sample run the answer drops from about 42,000 to about 25,000 characters. Pass `view: "full"` for the earlier shape; `get_finding_evidence` returns one finding's full row by `id`. The CLI output does not change.

- Each finding row (CLI JSON and MCP) has a `key`: the finding's type, rule and location, where a stage is the fingerprint that keys `metrics.stages`, an SQL execution is a digest of its stages' fingerprints, and a configuration finding is its property. It is a pairing aid for the same job across reruns, not a unique id and not a claim about whether the finding's value held. Findings are matched and ranked as before.
- `compare_runs` rows list the keys of the findings they count: `keys` on introduced and resolved rows, `keys` and `baseKeys` on changed rows (CLI `comparison.findings` too).
- `diagnose_run` takes `maxFindings` and `minBand` to limit the finding rows, reports `findingsOmitted`, and puts the lead finding row in each `verdict.steps[]` object as `leadFinding`.
- With `format: "md"`, `diagnose_run` returns a small `structuredContent` (`runId`, `runComplete`, `title`, `findingCount`, `findingsOmitted`, `recommendationCount`) instead of the full report.

Report schema 5 and metrics schema 1 are unchanged; every new field is additive.
