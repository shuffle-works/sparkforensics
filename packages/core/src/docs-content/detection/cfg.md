### `CFG`: Configuration audit {#cfg}

Flags configuration settings that may cause reliability or efficiency
problems, independent of any one stage's behavior. Four checks run
today:

- `spark.shuffle.service.enabled`: flagged when dynamic allocation is on
  but the external shuffle service is off, since shuffle data won't survive
  executor removal.
- `spark.dynamicAllocation.minExecutors`/`maxExecutors`: with dynamic
  allocation on, flagged when min exceeds max (reported on `minExecutors`)
  or when no max is set.
- `spark.serializer`: flagged when not set to Kryo (the default is the Java
  serializer); `org.apache.spark.serializer.KryoSerializer` is faster and
  produces smaller buffers.
- `spark.executor.memoryOverhead`: flagged when set below max(384 MiB, 10%
  of executor memory).
