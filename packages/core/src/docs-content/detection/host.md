### `HOST`: Slow host {#host}

One executor is much slower than its peers. It may just hold data locality
for its tasks or carry one heavy stage, rather than a hardware fault.
Enable `spark.speculation` to relaunch a lagging task automatically. Only
flagged on stages that take at least 0.5% of the run.
