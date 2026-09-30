### `GC`: Garbage collection pressure {#gc}

Tasks spend more than 10% of executor run time reclaiming memory. Reduce
object creation: use primitive types, avoid UDFs, or raise executor memory.
A stage with GC below 5% gets an informational note that executor memory
may be over-provisioned, only on stages that take at least 0.5% of the run.
Both need at least 10 s of executor run time on the stage.
