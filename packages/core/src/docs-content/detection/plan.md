### `PLAN`: Plan advisor {#plan}

Flags patterns in the SQL execution plan worth reviewing. Four checks share
this tag:

- Duplicate plan subtree: the same subtree recomputed more than once in the
  plan.
- Small files: reading an excessive number of small files.
- Under-broadcast: the smaller side of a Sort Merge Join looks well under
  the broadcast threshold; consider a `broadcast()` hint or raising
  `spark.sql.autoBroadcastJoinThreshold`.
- Over-broadcast: a broadcast exceeds the 1 GB threshold; check for a
  misapplied broadcast hint or a misconfigured
  `spark.sql.autoBroadcastJoinThreshold`.
