### `PLAN`: Plan advisor {#plan}

Flags patterns in the SQL execution plan worth reviewing. Four checks share
this tag:

- Duplicate plan subtree: the same subtree recomputed more than once in the
  plan. When the repeats have the same shape but different filters, columns
  or tables, the finding stays informational and claims no time. Only flagged
  when the repeat's stages take at least 0.5% of the run.
- Small files: one plan node reads or writes more than 100 files averaging
  under 3 MB. Compact upstream output, or coalesce before writing.
- Under-broadcast: the smaller side of a Sort Merge Join looks well under
  the broadcast threshold; consider a `broadcast()` hint or raising
  `spark.sql.autoBroadcastJoinThreshold`. When the effective threshold
  (logged, else Spark's 10 MiB) already admits the smaller side
  (`evidence.broadcastThreshold` is `notLimiting`), the threshold is not what
  stopped the broadcast, so `remediation` is empty and the advice is a hint or
  table statistics.
- Over-broadcast: a broadcast exceeds the 1 GB threshold; check for a
  misapplied broadcast hint or a misconfigured
  `spark.sql.autoBroadcastJoinThreshold`. When the effective threshold is
  below the broadcast or auto-broadcast is disabled (`evidence.broadcastThreshold`
  is `notLimiting` or `disabled`), a hint forced it: remove the hint, and
  `remediation` is empty.
