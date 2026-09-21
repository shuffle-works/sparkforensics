### `LOCAL`: Core usage locality {#local}

Tasks run without process- or node-local data placement more often than
expected. Check `spark.locality.wait` settings and executor/data colocation.
Self-flagged low-confidence: the non-local-ratio thresholds are our own
noise floor for this metric.
