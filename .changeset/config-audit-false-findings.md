---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

The configuration audit drops the findings that contradict how Spark behaves, and reads the overhead settings a run sets. Runs that carried these findings lose them, so a CI gate or baseline that counted them moves.

- The shuffle-service warning is gone. Spark refuses to start dynamic allocation without the external shuffle service unless shuffle tracking, shuffle-block decommissioning or a reliable shuffle storage plugin is on, and shuffle tracking defaults to on from Spark 3.4, so a logged run with dynamic allocation on and the service off always had one of them and its shuffle data was not at risk.
- The `minExecutors` above `maxExecutors` finding is gone. Spark throws on that pair at startup, so no run that wrote an event log has it. The unbounded `maxExecutors` note stays.
- The Kryo serializer note appears only on a run with at least one stage outside a SQL execution. DataFrame and SQL shuffles and caches use Spark's own row format, so `spark.serializer` does not apply to them. `auditConfig` takes the run's stages as a second argument; without them the note stays silent.
- The low `memoryOverhead` check compares against the default Spark would compute from the run's own `spark.executor.memoryOverheadFactor` (Spark 3.3 and later) and `spark.executor.minMemoryOverhead` (Spark 4.0 and later), falling back to 10% and 384 MiB, instead of always using those two values.
