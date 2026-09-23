### `GC`: Garbage collection pressure {#gc}

Tasks spend an unusually large share of time reclaiming memory. Reduce
object creation: use primitive types, avoid UDFs, or raise executor memory.
A stage with very little GC gets an informational note that executor memory
may be over-provisioned, only on stages that take at least 0.5% of the run.
