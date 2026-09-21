import { describe, it, expect } from 'vitest';
import { redactReport, redactAppIdentity, redactComparison, redactExportData } from '../src/redact.js';

function sampleReport() {
  return {
    schemaVersion: 1,
    summary: { app: { id: 'application_1785266278671_91739', name: 'nightly-etl', sparkVersion: '3.4.0' } },
    findings: [
      { id: 'a', type: 'slowHost', stageId: 4, host: 'ip-10-1-2-3.ec2.internal',
        recommendation: 'Check executor logs for ip-10-1-2-3.ec2.internal: possible bad node.' },
      { id: 'b', type: 'slowHost', stageId: 5, host: 'ip-10-9-8-7.ec2.internal',
        recommendation: 'Check executor logs for ip-10-9-8-7.ec2.internal: possible bad node.' },
    ],
  };
}

describe('redactReport', () => {
  it('replaces application ids and host names with stable pseudonyms', () => {
    const out = redactReport(sampleReport());
    expect(out.summary.app.id).toBe('app-1');
    // Hosts are pseudonymized in sorted order.
    expect(out.findings[0].host).toBe('host-1');
    expect(out.findings[1].host).toBe('host-2');
  });

  it('removes the original app id and host strings everywhere (incl. free text)', () => {
    const out = redactReport(sampleReport());
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('application_1785266278671_91739');
    expect(serialized).not.toContain('ip-10-1-2-3.ec2.internal');
    expect(serialized).not.toContain('ip-10-9-8-7.ec2.internal');
  });

  it('is deterministic: same input yields the same mapping', () => {
    expect(JSON.stringify(redactReport(sampleReport()))).toBe(JSON.stringify(redactReport(sampleReport())));
  });

  it('is idempotent: redacting an already-redacted report is a no-op', () => {
    const once = redactReport(sampleReport());
    const twice = redactReport(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('handles prefix-shadowing hosts: the shorter never corrupts the longer', () => {
    // 'ip-10-1-2' is a strict prefix of 'ip-10-1-2-3'; longest-first replacement keeps the longer host intact.
    const report = {
      schemaVersion: 1,
      summary: { app: { id: 'app_x' } },
      findings: [
        { id: 'a', type: 'slowHost', stageId: 1, host: 'ip-10-1-2',
          recommendation: 'Check executor logs for ip-10-1-2.' },
        { id: 'b', type: 'slowHost', stageId: 2, host: 'ip-10-1-2-3',
          recommendation: 'Check executor logs for ip-10-1-2-3.' },
      ],
    };
    const out = redactReport(report);
    // Sorted assignment: 'ip-10-1-2' -> host-1, 'ip-10-1-2-3' -> host-2.
    expect(out.findings[0].host).toBe('host-1');
    expect(out.findings[1].host).toBe('host-2');
    // The longer host is fully swapped, not partially clobbered.
    expect(out.findings[1].recommendation).toBe('Check executor logs for host-2.');
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('ip-10-1-2');
    expect(serialized).not.toContain('host-1-3');
  });

  it('does not mutate the input report', () => {
    const input = sampleReport();
    redactReport(input);
    expect(input.summary.app.id).toBe('application_1785266278671_91739');
  });

  it('is idempotent at >=10 hosts (numeric-aware pseudonym ordering)', () => {
    // 12 hosts force host-1..host-12; a lexicographic second pass would re-slot host-10 -> host-2, numeric-aware sorting must not.
    const findings = Array.from({ length: 12 }, (_, i) => ({
      id: `f${i}`, type: 'slowHost', stageId: i,
      host: `ip-10-0-0-${i + 1}.ec2.internal`,
      recommendation: `Check executor logs for ip-10-0-0-${i + 1}.ec2.internal.`,
    }));
    const report = { schemaVersion: 1, summary: { app: { id: 'app_x' } }, findings };
    const once = redactReport(report);
    const twice = redactReport(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    const serialized = JSON.stringify(once);
    for (let i = 1; i <= 12; i++) expect(serialized).not.toContain(`ip-10-0-0-${i}.ec2.internal`);
    expect(JSON.stringify(once)).toContain('host-12');
  });

  it('redacts host/IP identifiers that appear only in free-text values', () => {
    // Host in a stageFailed value string (never a `host` field) plus a bare IPv4 in a recommendation; both must be pseudonymized.
    const report = {
      schemaVersion: 1,
      summary: { app: { id: 'app_x' } },
      findings: [
        { id: 'a', type: 'stageFailed', stageId: 7,
          value: 'ExecutorLostFailure on ip-10-4-5-6.ec2.internal: Container killed' },
        { id: 'b', type: 'slowHost', stageId: 8,
          recommendation: 'Driver at 10.20.30.40 saw slow fetches.' },
      ],
    };
    const serialized = JSON.stringify(redactReport(report));
    expect(serialized).not.toContain('ip-10-4-5-6.ec2.internal');
    expect(serialized).not.toContain('10.20.30.40');
    expect(serialized).toMatch(/host-\d+/);
  });

  it('redacts hosts nested inside evidence task-detail arrays', () => {
    // Plain FQDNs, matching neither HOST_PATTERN, so they can only be caught by walking the tree
    // for `host` keys, the shape real task records carry (evidence.retriedTaskDetails[].host).
    const report = {
      schemaVersion: 1,
      summary: { app: { id: 'app_x' } },
      findings: [
        { id: 'a', type: 'retryWaste', stageId: 3,
          evidence: {
            retriedTaskDetails: [
              { taskId: 11, attemptNumber: 1, host: 'worker-3.internal', executorId: '7' },
              { taskId: 12, attemptNumber: 2, host: 'hadoop-dn-070.data.example.com', executorId: '8' },
            ],
          } },
        { id: 'b', type: 'stageFailed', stageId: 4,
          evidence: { failedTaskDetails: [{ taskId: 21, attemptNumber: 0, host: 'worker-9.internal' }] } },
      ],
    };
    const out = redactReport(report);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('worker-3.internal');
    expect(serialized).not.toContain('hadoop-dn-070.data.example.com');
    expect(serialized).not.toContain('worker-9.internal');
    expect(out.findings[0].evidence.retriedTaskDetails[0].host).toMatch(/^host-\d+$/);
    expect(out.findings[1].evidence.failedTaskDetails[0].host).toMatch(/^host-\d+$/);
  });

  it('pseudonymizes a Spark application id embedded in free text, like redactComparison does', () => {
    // A second app id appears only in recommendation free text, never in summary.app.id.
    const report = {
      schemaVersion: 1,
      summary: { app: { id: 'application_1785266278671_91739' } },
      findings: [
        { id: 'a', type: 'retryWaste', stageId: 3,
          recommendation: 'Retried after application_1690000000000_0001 failed.' },
      ],
    };
    const out = redactReport(report);
    expect(out.findings[0].recommendation).toMatch(/app-\d+/);
    expect(JSON.stringify(out)).not.toContain('application_1690000000000_0001');
  });
});

describe('redactAppIdentity', () => {
  it('pseudonymizes a non-empty app id', () => {
    const out = redactAppIdentity({ id: 'application_1785266278671_91739', name: 'nightly-etl', sparkVersion: '3.4.0' });
    expect(out.id).toBe('app-1');
  });

  it('pseudonymizes a host-shaped app name', () => {
    const out = redactAppIdentity({ id: 'app_x', name: 'run-on-ip-10-1-2-3.ec2.internal', sparkVersion: '3.4.0' });
    expect(out.name).not.toContain('ip-10-1-2-3.ec2.internal');
    expect(out.name).toMatch(/host-\d+/);
  });

  it('passes sparkVersion through unless it is host-shaped', () => {
    const out = redactAppIdentity({ id: 'app_x', name: 'nightly-etl', sparkVersion: '3.4.0' });
    expect(out.sparkVersion).toBe('3.4.0');
  });

  it('pseudonymizes a host-shaped sparkVersion the same way as name', () => {
    const out = redactAppIdentity({ id: 'app_x', name: 'nightly-etl', sparkVersion: 'built on 10.20.30.40' });
    expect(out.sparkVersion).not.toContain('10.20.30.40');
    expect(out.sparkVersion).toMatch(/host-\d+/);
  });

  it('handles null id/name/sparkVersion without throwing', () => {
    const out = redactAppIdentity({ id: null, name: null, sparkVersion: null });
    expect(out).toEqual({ id: null, name: null, sparkVersion: null });
  });
});

describe('redactComparison', () => {
  function sampleComparison() {
    return {
      baselineLabel: 'baseline', candidateLabel: 'candidate',
      confidence: 'ok', reason: null, matchedCoverage: 1,
      metrics: [{ key: 'wallClock', label: 'Wall-clock duration', baseline: 100, candidate: 200, delta: 100, direction: 'regression' }],
      findings: {
        introduced: [{ rule: 'straggler', impactBand: 'info', baseCount: 0, candCount: 1, delta: 1,
          stages: ['collect at ip-10-1-2-3.ec2.internal.scala:42'] }],
        resolved: [],
      },
      baseStages: [{ id: 1, name: 'collect at ip-10-1-2-3.ec2.internal.scala:42', metrics: {} }],
      candStages: [{ id: 1, name: 'collect at ip-10-1-2-3.ec2.internal.scala:42', metrics: {} }],
    };
  }

  it('pseudonymizes host/IP tokens embedded in stage names', () => {
    const out = redactComparison(sampleComparison());
    expect(out.findings.introduced[0].stages[0]).toMatch(/host-\d+/);
    expect(out.baseStages[0].name).toMatch(/host-\d+/);
    expect(out.candStages[0].name).toBe(out.baseStages[0].name);
  });

  it('removes the original host string everywhere', () => {
    const serialized = JSON.stringify(redactComparison(sampleComparison()));
    expect(serialized).not.toContain('ip-10-1-2-3.ec2.internal');
  });

  it('leaves numeric metrics and non-host free text untouched', () => {
    const out = redactComparison(sampleComparison());
    expect(out.metrics[0]).toEqual(sampleComparison().metrics[0]);
    expect(out.baselineLabel).toBe('baseline');
    expect(out.candidateLabel).toBe('candidate');
  });

  it('does not mutate the input', () => {
    const input = sampleComparison();
    redactComparison(input);
    expect(input.findings.introduced[0].stages[0]).toBe('collect at ip-10-1-2-3.ec2.internal.scala:42');
  });

  it('pseudonymizes a Spark application id embedded in free text, like redactReport does for its structured app.id', () => {
    const comparison = sampleComparison();
    comparison.baseStages[0].name = 'broadcast exchange for application_1690000000000_0001';
    comparison.candStages[0].name = 'broadcast exchange for application_1690000000000_0001';
    const out = redactComparison(comparison);
    expect(out.baseStages[0].name).toMatch(/app-\d+/);
    expect(out.candStages[0].name).toBe(out.baseStages[0].name);
    expect(JSON.stringify(out)).not.toContain('application_1690000000000_0001');
  });
});

describe('redactExportData', () => {
  function sampleExportData() {
    return {
      schemaVersion: 1,
      app: {
        id: 'application_1690000000000_0001', name: 'my-app', sparkVersion: '3.5.0',
        config: {
          'spark.driver.host': 'driver-7.internal.corp',
          'spark.yarn.am.hostname': 'am-node-2.internal.corp',
          'spark.executor.instances': '4',
        },
      },
      stages: [{ id: 1, name: 'collect at ip-10-1-2-3.ec2.internal.scala:42' }],
      jobs: [],
      sql: [],
      executors: {
        added: [{ kind: 'added', timestamp: 0, executorId: '1', host: 'worker-3.internal', totalCores: 4, resourceProfileId: null }],
        removed: [],
      },
      runAggregates: null,
      evidenceAvailability: null,
      catalog: [{ type: 'skew', stageId: 1, impactBand: 'warning', recommendation: 'retry app application_1690000000000_0001 failed' }],
      configFindings: [{ type: 'configAudit', property: 'spark.executor.host', value: 'worker-3.internal', impactBand: 'info' }],
      skippedLines: 0,
    };
  }

  it('pseudonymizes the app id everywhere it appears', () => {
    const out = redactExportData(sampleExportData());
    expect(out.app.id).toMatch(/app-\d+/);
    expect(out.catalog[0].recommendation).toContain(out.app.id);
    expect(JSON.stringify(out)).not.toContain('application_1690000000000_0001');
  });

  it("pseudonymizes an executor's literal host field, not just IP-shaped free text", () => {
    const out = redactExportData(sampleExportData());
    expect(out.executors.added[0].host).toMatch(/host-\d+/);
    expect(out.executors.added[0].host).not.toBe('worker-3.internal');
  });

  it('pseudonymizes an IP-shaped host token embedded in a stage name', () => {
    const out = redactExportData(sampleExportData());
    expect(out.stages[0].name).toMatch(/host-\d+/);
    expect(out.stages[0].name).not.toContain('ip-10-1-2-3.ec2.internal');
  });

  it('reaches configFindings, not just catalog', () => {
    const out = redactExportData(sampleExportData());
    expect(out.configFindings[0].value).toMatch(/host-\d+/);
  });

  it('does not mutate the input', () => {
    const input = sampleExportData();
    redactExportData(input);
    expect(input.app.id).toBe('application_1690000000000_0001');
  });

  it('pseudonymizes plain-FQDN hosts living under host/hostname-suffixed app.config keys', () => {
    const out = redactExportData(sampleExportData());
    expect(out.app.config['spark.driver.host']).toMatch(/^host-\d+$/);
    expect(out.app.config['spark.yarn.am.hostname']).toMatch(/^host-\d+$/);
    // A config value that isn't under a host/hostname-suffixed key is left alone.
    expect(out.app.config['spark.executor.instances']).toBe('4');
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('driver-7.internal.corp');
    expect(serialized).not.toContain('am-node-2.internal.corp');
  });
});
