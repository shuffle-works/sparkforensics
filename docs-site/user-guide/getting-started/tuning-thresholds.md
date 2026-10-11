# Tuning detector thresholds

How to run a detector check with your own threshold instead of its default.

Every check fires at a fixed default threshold. When your normal workload
trips one on purpose, such as a join you skew deliberately, pass
`--thresholds <file>` to run that check with your own value. The file is
JSON, keyed by detector, then by threshold name:

```json
{
  "skew": { "ratioWarn": 6 },
  "shuffle": { "minBytes": 1073741824 }
}
```

The names, units and defaults are the `detectors` catalog in the CLI's JSON
report (`thresholds` on each row): bytes are raw byte counts, times are
milliseconds, and `*Pct`/`*Rate` values are fractions (`0.05` is 5%). A tier
list such as `slowHost.ratioTiers` takes the same number of values, in
ascending order. The `configAudit` checks can't be tuned: they compare your
Spark settings against Spark's own defaults.

The CLI refuses to run, with exit code 2 and a message naming the problem,
when the file can't be read, isn't valid JSON, or names an unknown detector
or threshold, or a value of the wrong shape. It never falls back to the
defaults silently.

A tuned run says so wherever it reports:

- Each finding from a tuned detector carries `tunedThresholds` (each
  overridden threshold's `value` and `default`), and its `validationRequired`
  text names them and, when the finding has an impact estimate, says that
  estimate is unvalidated. The estimates are calibrated
  against the default thresholds, so they were never checked for a finding
  your override lets through. Tuning `slowHost` also labels `stageSlowness`
  findings (as `slowHost.<name>`), because a slow host hides a stage's
  slowness finding, so the override decides which of those you see.
  Tuning `skew` labels `straggler` findings the same way (as `skew.<name>`),
  because `straggler` reports the slow tails `skew`'s thresholds leave to it.
- A clean check measured against a tuned threshold carries
  `tunedThresholds` too, with the tuned value and the default. Its
  `thresholdSummary` shows the tuned numbers for most detectors (for example
  `skew`, `gc`, `spill`, `slowHost`). A few summaries are fixed text with no
  number to tune.
- `summary.tunedThresholds` lists every tuned detector, and each tuned row
  of the `detectors` catalog shows the thresholds the run used.
- The Markdown report adds a `Tuned thresholds` line to its header and a
  `tuned thresholds` line to each affected finding.

An override equal to the default changes nothing and is not labeled.
`--baseline` runs the baseline with the same overrides, so the comparison
compares like with like. The budget flags are separate gates computed from
the run's own figures; the one that recomputes a detector's figure,
`--max-skew`, uses the file's `skew.minTasksForP95`, so it measures the
same ratio the skew finding reports. `--export-html` writes the dashboard
with the default thresholds, because the dashboard never tunes, and prints
a note to stderr saying so. The browser dashboard has no tuning.
