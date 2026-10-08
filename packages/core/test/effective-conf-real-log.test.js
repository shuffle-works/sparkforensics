import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { collectRun } from '../src/cli/collect-run.ts';
import { effectiveSparkConf } from '../src/spark-conf.ts';

// A Spark 4.0.4 local run with spark.speculation and spark.sql.shuffle.partitions=16 on the
// submit line, whose second query sets the broadcast threshold, the shuffle partition count and the
// AQE skew threshold at runtime with spark.conf.set.
const LOG = fileURLToPath(new URL('./fixtures/runtime-conf-spark-4.0.ndjson', import.meta.url));

describe('effective conf of a real Spark 4.0 log with runtime settings', () => {
  it('layers the second query\'s modifiedConfigs over the app properties and the 4.0 defaults', async () => {
    const { appModel } = await collectRun(LOG);
    const { app, sql } = appModel;
    expect(app.sparkVersion).toBe('4.0.4');
    const [first, second] = [...sql.values()].sort((a, b) => a.id - b.id);
    expect(first.modifiedConfigs).toBeUndefined();
    expect(second.modifiedConfigs).toEqual({
      'spark.sql.autoBroadcastJoinThreshold': '-1',
      'spark.sql.shuffle.partitions': '8',
      'spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes': '4MB',
    });

    const conf = (modified, key) => effectiveSparkConf({ sparkVersion: app.sparkVersion, properties: app.config, modified }, key);
    expect(conf(first.modifiedConfigs, 'spark.sql.shuffle.partitions')).toEqual({ value: '16', source: 'app' });
    expect(conf(second.modifiedConfigs, 'spark.sql.shuffle.partitions')).toEqual({ value: '8', source: 'query' });
    expect(conf(second.modifiedConfigs, 'spark.sql.autoBroadcastJoinThreshold')).toEqual({ value: '-1', source: 'query' });
    expect(conf(first.modifiedConfigs, 'spark.sql.autoBroadcastJoinThreshold')).toEqual({ value: '10MB', source: 'default' });
    expect(conf(second.modifiedConfigs, 'spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes')).toEqual({ value: '4MB', source: 'query' });
    expect(conf(first.modifiedConfigs, 'spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes')).toEqual({ value: '256MB', source: 'default' });
    expect(conf(undefined, 'spark.speculation')).toEqual({ value: 'true', source: 'app' });
    expect(conf(undefined, 'spark.speculation.multiplier')).toEqual({ value: '3', source: 'default' });
    expect(conf(undefined, 'spark.speculation.quantile')).toEqual({ value: '0.9', source: 'default' });
  });
});
