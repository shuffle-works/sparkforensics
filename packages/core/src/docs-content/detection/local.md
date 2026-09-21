### `LOCAL`: Core usage locality {#local}

Tasks run without process- or node-local data placement more often than
expected. Check `spark.locality.wait` settings and executor/data colocation.
Self-flags a confidence that scales with the non-local ratio and sample
size: the thresholds are our own noise floor for this metric.
