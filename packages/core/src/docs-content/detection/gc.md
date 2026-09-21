### `GC`: Garbage collection pressure {#gc}

Tasks spend an unusually large share of time reclaiming memory. Reduce
object creation: use primitive types, avoid UDFs, or raise executor memory.
