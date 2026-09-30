import { describe, it, expect } from 'vitest';
import { buildEffectiveConf, stripUrlCredentials, compileJvmPattern } from '../src/effective-conf.ts';

const app = (config) => ({ config });

describe('buildEffectiveConf', () => {
  it('lists every key, withholding values whose key matches the default secret pattern', () => {
    const conf = buildEffectiveConf(app({
      'spark.executor.memory': '4g',
      'spark.hadoop.fs.s3a.secret.key': 's3cr3t',
      'spark.hadoop.fs.s3a.access.key': 'AKIA',
      'spark.hadoop.fs.s3a.accesskey': 'AKIA',
      'spark.ssl.keyPassword': 'pw',
      'spark.authenticate.TOKEN': 'tok',
    }));
    expect(conf.values).toEqual({ 'spark.executor.memory': '4g' });
    expect(conf.maskedKeys).toEqual([
      'spark.authenticate.TOKEN', 'spark.hadoop.fs.s3a.access.key', 'spark.hadoop.fs.s3a.accesskey',
      'spark.hadoop.fs.s3a.secret.key', 'spark.ssl.keyPassword',
    ]);
    const text = JSON.stringify(conf);
    for (const leaked of ['s3cr3t', 'AKIA', '"pw"', '"tok"']) expect(text).not.toContain(leaked);
  });

  it('applies the job\'s own spark.redaction.regex to keys and values', () => {
    const conf = buildEffectiveConf(app({
      'spark.redaction.regex': '(?i)private|jdbc',
      'spark.my.PRIVATE.thing': 'x',
      'spark.plain': 'jdbc:postgresql://db/x',
      'spark.ok': 'fine',
    }));
    expect(conf.maskedKeys).toEqual(['spark.my.PRIVATE.thing', 'spark.plain', 'spark.redaction.regex']);
    expect(conf.values['spark.ok']).toBe('fine');
    expect(conf.redaction).toMatchObject({ jobPattern: '(?i)private|jdbc', jobPatternUsable: true });
  });

  it('withholds every value when the job\'s pattern cannot be evaluated', () => {
    const conf = buildEffectiveConf(app({ 'spark.redaction.regex': '(?<n>a)\\k<m>(', 'spark.a': '1' }));
    expect(conf.redaction.jobPatternUsable).toBe(false);
    expect(conf.values).toEqual({});
    expect(conf.maskedKeys).toEqual(['spark.a', 'spark.redaction.regex']);
  });

  it('applies a user-supplied pattern and rejects an invalid one', () => {
    const conf = buildEffectiveConf(app({ 'spark.internal.url': 'x', 'spark.a': 'b' }), { userPattern: 'internal' });
    expect(conf.maskedKeys).toEqual(['spark.internal.url']);
    expect(() => buildEffectiveConf(app({}), { userPattern: '(' })).toThrow(/invalid secret pattern/);
  });

  it('narrows to the requested keys and reports the ones the log lacks', () => {
    const conf = buildEffectiveConf(app({ 'spark.a': '1', 'spark.b': '2', 'spark.x.password': 'p' }), {
      keys: ['spark.a', 'spark.x.password', 'spark.missing'],
    });
    expect(conf.values).toEqual({ 'spark.a': '1' });
    expect(conf.maskedKeys).toEqual(['spark.x.password']);
    expect(conf.absentKeys).toEqual(['spark.missing']);
  });

  it('is null when the log records no Spark Properties', () => {
    expect(buildEffectiveConf({}, {})).toBeNull();
    expect(buildEffectiveConf(null)).toBeNull();
  });

  it('never emits a hash or other derivative of a withheld value', () => {
    const conf = buildEffectiveConf(app({ 'spark.a.password': 'hunter2' }));
    expect(Object.keys(conf).sort()).toEqual(['absentKeys', 'maskedKeys', 'redaction', 'schemaVersion', 'values']);
  });

  it('withholds host names and the app name under redactIdentifiers', () => {
    const conf = buildEffectiveConf(app({ 'spark.driver.host': 'node-7', 'spark.app.name': 'job', 'spark.a': '1' }), { redactIdentifiers: true });
    expect(conf.maskedKeys).toEqual(['spark.app.name', 'spark.driver.host']);
  });
});

describe('stripUrlCredentials', () => {
  it('removes userinfo, password parameters and signature parameters from URL-like values', () => {
    expect(stripUrlCredentials('https://user:pa55@host.example/path')).toBe('https://[redacted]@host.example/path');
    expect(stripUrlCredentials('https://token123@github.com/o/r')).toBe('https://[redacted]@github.com/o/r');
    expect(stripUrlCredentials('jdbc:sqlserver://h:1433;databaseName=d;user=u;password=pa55;encrypt=true'))
      .toBe('jdbc:sqlserver://h:1433;databaseName=d;user=u;password=[redacted];encrypt=true');
    expect(stripUrlCredentials('jdbc:postgresql://h/db?user=u&Password=pa55&ssl=true'))
      .toBe('jdbc:postgresql://h/db?user=u&Password=[redacted]&ssl=true');
    expect(stripUrlCredentials('https://acct.blob.core.windows.net/c?sv=2021&sig=AbC%2Fd%3D&se=2030'))
      .toBe('https://acct.blob.core.windows.net/c?sv=2021&sig=[redacted]&se=2030');
    expect(stripUrlCredentials('https://b.s3.amazonaws.com/k?X-Amz-Signature=abcd&X-Amz-Expires=60'))
      .toBe('https://b.s3.amazonaws.com/k?X-Amz-Signature=[redacted]&X-Amz-Expires=60');
  });

  it('leaves non-URL values and credential-free URLs alone', () => {
    for (const v of ['4g', 'password=x', 'yarn', 'hdfs://nn:8020/user/x', 'a,b,c']) expect(stripUrlCredentials(v)).toBe(v);
  });

  it('handles each URL in a comma-separated list', () => {
    expect(stripUrlCredentials('https://u:p@a/x.jar,https://b/y.jar')).toBe('https://[redacted]@a/x.jar,https://b/y.jar');
  });
});

describe('compileJvmPattern', () => {
  it('reads JVM inline flags and rejects JVM-only syntax', () => {
    expect(compileJvmPattern('(?i)secret').test('SECRET')).toBe(true);
    expect(compileJvmPattern('secret').test('SECRET')).toBe(false);
    expect(compileJvmPattern('(?x)a b')).toBeNull();
  });
});
