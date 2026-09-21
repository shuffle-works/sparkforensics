### `PART`: Partition sizing {#part}

Shuffle partitions are too large, too uneven, or too few for the work. A
single shuffle partition over 5 GB, for example, will OOM or spill heavily:
repartition to break it up before the stage runs.
