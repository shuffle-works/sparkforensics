### `SPILL`: Memory and disk spill {#spill}

Tasks are writing data out of memory, which slows execution. Two spill
patterns get flagged differently: skew spill, where a few heavy tasks spill
while most don't (rebalance partitioning), and volume spill, where most
tasks spill because the data genuinely exceeds available memory (add
partitions).
