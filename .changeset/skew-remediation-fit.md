---
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-web": minor
---

Skew remediation now fits the stage and the run's effective conf, and every median is the textbook median.

**Median.** The P50 of task duration, shuffle read and spill (`taskDurationP50`, `shuffleReadP50`, `spillMemP50`, `spillDiskP50`) is the mean of the two middle values on an even task count; it was the lower middle value. The slow-host mean-duration median and the executor max/median ratio took the upper middle value and now use the same median. P95 and max are unchanged. A bimodal stage with six tasks of 137, 219, 257, 28345, 34157 and 44374 ms now reports max/median 3.1 instead of 172.7, so such stages no longer lead the findings by an inflated ratio, and some skew, straggler and stage-shape findings that only cleared their threshold on the lower median no longer fire.

**Effective conf.** A conf a finding would set is left out when its effective value already matches: the logged property, else Spark's default for the run's `sparkVersion`. Modeled defaults are `spark.sql.adaptive.enabled` (on from Spark 3.2) and `spark.sql.adaptive.skewJoin.enabled` (on from 3.0). On Spark 3.5 with AQE on, skew findings no longer suggest `spark.sql.adaptive.skewJoin.enabled`; on Spark 3.0 and 3.1 with AQE unlogged they suggest `spark.sql.adaptive.enabled`.

**Stage shape.** Skew-join handling is suggested only for a stage that reads a shuffle in a SQL execution whose plan has a sort-merge or shuffled-hash join. Skew findings and `shufflePartitionSkew` gain `evidence.origin` (`shuffleJoin`, `inputScan` or `other`). A scan stage with uneven input gets a `spark.sql.files.maxPartitionBytes` decrease and file-size advice, and any other stage gets the salting advice with no conf. `stageSlowness` gains `evidence.reads` (`shuffle`, `input` or `other`) and suggests `spark.sql.shuffle.partitions` and `spark.default.parallelism` only for a stage that reads a shuffle; a scan stage gets the `maxPartitionBytes` decrease instead.

**Other finding types.** The same three checks now apply wherever a finding carries a conf or a median:

- `spill` and `tinyTask` suggest `spark.sql.shuffle.partitions` only for a stage that reads a shuffle, and carry `evidence.reads`.
- `shuffle` and `partitionSizing` (`lowShuffleParallelism`) read the effective `spark.sql.shuffle.partitions` (logged, else Spark's 200), and carry `evidence.partitions`: `raise`, `sufficient` (tasks already a good size), `aqeCoalesced` (AQE merged the partitions, so `spark.sql.adaptive.advisoryPartitionSizeInBytes` is the lever) or `ownPartitioning`. A shuffle finding with no partition-count problem now has an empty `remediation`.
- `autoscalingChurn` and `coldStart` suggest no dynamic-allocation property when the run turns it off, and carry `evidence.dynamicAllocation`.
- `straggler` words its skew advice from the stage as a skew finding does, carries the matching `remediation` and `evidence.origin`.
- `underBroadcast` and `overBroadcast` compare against the effective `spark.sql.autoBroadcastJoinThreshold` (logged, else 10 MiB, `-1` disabled) and carry `evidence.broadcastThreshold`; a threshold that already admits the smaller side, or is already below the broadcast, is not suggested.
- A skew finding on Spark before 3.0 suggests no AQE conf.
- `speculationWaste` carries `evidence.wastedAttempts`.
- Effective defaults modeled: `spark.sql.shuffle.partitions` (200), `spark.sql.autoBroadcastJoinThreshold` (10 MiB), `spark.sql.adaptive.coalescePartitions.enabled` (on from 3.0), besides the AQE keys above.
