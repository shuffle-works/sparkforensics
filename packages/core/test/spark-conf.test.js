import { describe, it, expect } from 'vitest';
import { effectiveSparkConf, overlayModifiedConfigs, parseSparkBytes, sparkConfDefault } from '../src/spark-conf.ts';

const RELEASES = ['3.0.0', '3.1.3', '3.2.0', '3.3.0', '3.4.0', '3.5.9', '4.0.4', '4.1.0', '4.2.0'];
const at = (key) => Object.fromEntries(RELEASES.map((v) => [v, sparkConfDefault(v, key)]));

// Each expectation is a default read from Spark's SQLConf.scala / config/package.scala at the
// release tag that introduced it (e.g. v4.0.0 for the speculation change).
describe('sparkConfDefault by Spark version', () => {
  it('moves the speculation multiplier and quantile at 4.0', () => {
    expect(at('spark.speculation.multiplier')).toEqual({
      '3.0.0': '1.5', '3.1.3': '1.5', '3.2.0': '1.5', '3.3.0': '1.5', '3.4.0': '1.5', '3.5.9': '1.5',
      '4.0.4': '3', '4.1.0': '3', '4.2.0': '3',
    });
    expect(at('spark.speculation.quantile')).toEqual({
      '3.0.0': '0.75', '3.1.3': '0.75', '3.2.0': '0.75', '3.3.0': '0.75', '3.4.0': '0.75', '3.5.9': '0.75',
      '4.0.4': '0.9', '4.1.0': '0.9', '4.2.0': '0.9',
    });
    expect(Object.values(at('spark.speculation'))).toEqual(RELEASES.map(() => 'false'));
  });

  it('turns adaptive execution on at 3.2 and shuffle tracking on at 3.4', () => {
    expect(Object.values(at('spark.sql.adaptive.enabled'))).toEqual(['false', 'false', ...Array(7).fill('true')]);
    expect(Object.values(at('spark.dynamicAllocation.shuffleTracking.enabled')))
      .toEqual(['false', 'false', 'false', 'false', ...Array(5).fill('true')]);
  });

  it('introduces each adaptive property at the release that added it', () => {
    expect(Object.values(at('spark.sql.adaptive.skewJoin.enabled'))).toEqual(RELEASES.map(() => 'true'));
    expect(Object.values(at('spark.sql.adaptive.coalescePartitions.parallelismFirst')))
      .toEqual([undefined, undefined, ...Array(7).fill('true')]);
    expect(Object.values(at('spark.sql.adaptive.coalescePartitions.minPartitionSize')))
      .toEqual([undefined, undefined, ...Array(7).fill('1MB')]);
    expect(Object.values(at('spark.sql.adaptive.forceOptimizeSkewedJoin')))
      .toEqual([undefined, undefined, undefined, ...Array(6).fill('false')]);
  });

  it('keeps the values that no release from 3.0 to 4.2 changed', () => {
    const constant = {
      'spark.sql.shuffle.partitions': '200',
      'spark.sql.autoBroadcastJoinThreshold': '10MB',
      'spark.sql.files.maxPartitionBytes': '128MB',
      'spark.sql.adaptive.advisoryPartitionSizeInBytes': '64MB',
      'spark.sql.adaptive.skewJoin.skewedPartitionFactor': '5',
      'spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes': '256MB',
      'spark.sql.adaptive.coalescePartitions.enabled': 'true',
      'spark.executor.memory': '1g',
      'spark.serializer': 'org.apache.spark.serializer.JavaSerializer',
      'spark.shuffle.service.enabled': 'false',
      'spark.dynamicAllocation.enabled': 'false',
      'spark.dynamicAllocation.minExecutors': '0',
      'spark.dynamicAllocation.maxExecutors': '2147483647',
      'spark.dynamicAllocation.executorIdleTimeout': '60s',
      'spark.eventLog.logBlockUpdates.enabled': 'false',
      'spark.eventLog.logStageExecutorMetrics': 'false',
    };
    for (const [key, value] of Object.entries(constant)) {
      expect(Object.values(at(key)), key).toEqual(RELEASES.map(() => value));
    }
  });

  it('reads the major and minor from a vendor or snapshot version string', () => {
    expect(sparkConfDefault('4.0.0-SNAPSHOT', 'spark.speculation.multiplier')).toBe('3');
    expect(sparkConfDefault('3.5.1-amzn-0', 'spark.speculation.multiplier')).toBe('1.5');
  });

  it('answers a version-independent default for a run with no recorded version, and nothing else', () => {
    for (const version of [null, undefined, '', 'unknown']) {
      expect(sparkConfDefault(version, 'spark.sql.shuffle.partitions')).toBe('200');
      expect(sparkConfDefault(version, 'spark.sql.autoBroadcastJoinThreshold')).toBe('10MB');
      expect(sparkConfDefault(version, 'spark.speculation.multiplier')).toBeUndefined();
      expect(sparkConfDefault(version, 'spark.sql.adaptive.enabled')).toBeUndefined();
      expect(sparkConfDefault(version, 'spark.sql.adaptive.skewJoin.enabled')).toBeUndefined();
    }
  });

  it('has no default for a property whose value depends on the cluster or on another property', () => {
    for (const key of ['spark.executor.instances', 'spark.default.parallelism', 'spark.executor.memoryOverhead',
      'spark.dynamicAllocation.initialExecutors', 'spark.sql.adaptive.autoBroadcastJoinThreshold', 'spark.not.a.key']) {
      expect(sparkConfDefault('3.5.9', key), key).toBeUndefined();
    }
  });
});

describe('effectiveSparkConf layering', () => {
  const layers = {
    sparkVersion: '4.0.4',
    properties: { 'spark.sql.shuffle.partitions': ' 64 ', 'spark.sql.autoBroadcastJoinThreshold': '20MB' },
    modified: { 'spark.sql.autoBroadcastJoinThreshold': '-1', 'spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes': '4MB' },
  };

  it('prefers the per-query value, then the app property, then the version default', () => {
    expect(effectiveSparkConf(layers, 'spark.sql.autoBroadcastJoinThreshold')).toEqual({ value: '-1', source: 'query' });
    expect(effectiveSparkConf(layers, 'spark.sql.shuffle.partitions')).toEqual({ value: '64', source: 'app' });
    expect(effectiveSparkConf(layers, 'spark.speculation.multiplier')).toEqual({ value: '3', source: 'default' });
    expect(effectiveSparkConf(layers, 'spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes'))
      .toEqual({ value: '4MB', source: 'query' });
  });

  it('is undefined for a key no layer has', () => {
    expect(effectiveSparkConf(layers, 'spark.executor.instances')).toBeUndefined();
    expect(effectiveSparkConf({}, 'spark.sql.shuffle.partitions')).toEqual({ value: '200', source: 'default' });
  });

  it('ignores a per-query value Spark redacted, including a custom redaction string', () => {
    const redacted = { 'spark.sql.shuffle.partitions': '*********(redacted)' };
    expect(effectiveSparkConf({ properties: { 'spark.sql.shuffle.partitions': '8' }, modified: redacted }, 'spark.sql.shuffle.partitions'))
      .toEqual({ value: '8', source: 'app' });
    const custom = { properties: { 'spark.redaction.string': '<hidden>' }, modified: { 'spark.x': '<hidden>', 'spark.y': '1' } };
    expect(effectiveSparkConf(custom, 'spark.x')).toBeUndefined();
    expect(effectiveSparkConf(custom, 'spark.y')).toEqual({ value: '1', source: 'query' });
  });
});

describe('overlayModifiedConfigs', () => {
  it('returns the properties object itself when there is nothing to apply', () => {
    const properties = { a: '1' };
    expect(overlayModifiedConfigs(properties, undefined)).toBe(properties);
    expect(overlayModifiedConfigs(properties, {})).toBe(properties);
    expect(overlayModifiedConfigs(properties, { a: '*********(redacted)' })).toBe(properties);
  });

  it('applies the per-query values over a copy, and builds from nothing when the app logged no properties', () => {
    const properties = { a: '1', b: '2' };
    expect(overlayModifiedConfigs(properties, { b: '3', c: '4' })).toEqual({ a: '1', b: '3', c: '4' });
    expect(properties).toEqual({ a: '1', b: '2' });
    expect(overlayModifiedConfigs(undefined, { c: '4' })).toEqual({ c: '4' });
  });
});

describe('parseSparkBytes', () => {
  it('reads plain numbers and k/m/g/t suffixes, with or without a trailing b', () => {
    expect(parseSparkBytes('10485760')).toBe(10485760);
    expect(parseSparkBytes('10MB')).toBe(10 * 1024 * 1024);
    expect(parseSparkBytes('4g')).toBe(4 * 1024 ** 3);
    expect(parseSparkBytes('1.5k')).toBe(1536);
    expect(parseSparkBytes('-1')).toBe(-1);
  });

  it('is null for anything else', () => {
    for (const bad of [undefined, '', 'abc', '10 parsecs', '1e3']) expect(parseSparkBytes(bad)).toBeNull();
  });
});
