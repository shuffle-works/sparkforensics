### `CFG`: Configuration audit {#cfg}

Flags configuration settings that may cause reliability or efficiency
problems, independent of any one stage's behavior. Four properties are
audited today:

- `spark.shuffle.service.enabled`: flagged when dynamic allocation is on
  but the external shuffle service is off, since shuffle data won't survive
  executor removal.
- `spark.dynamicAllocation.maxExecutors`: flagged for inverted bounds or a
  missing upper bound.
- `spark.serializer`: flagged when still on the default Java serializer;
  `org.apache.spark.serializer.KryoSerializer` is faster and produces
  smaller buffers.
- `spark.executor.memoryOverhead`: flagged when set below a safe floor.
