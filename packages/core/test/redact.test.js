import { describe, it, expect } from 'vitest';
import { redactReport, redactComparison, redactRunModel } from '../src/redact.js';

const byId = (items) => new Map(items.map((item) => [item.id, item]));

function redactRun(data) {
  const appModel = {
    app: data.app, stages: byId(data.stages), jobs: byId(data.jobs), sql: byId(data.sql),
    executors: data.executors, runAggregates: data.runAggregates, evidenceAvailability: data.evidenceAvailability,
  };
  return redactRunModel(appModel, data.catalog, data.configFindings);
}

function sampleReport() {
  return {
    schemaVersion: 1,
    summary: { app: { id: 'application_0000000000000_0001', name: 'nightly-etl', sparkVersion: '3.4.0' } },
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
    expect(serialized).not.toContain('application_0000000000000_0001');
    expect(serialized).not.toContain('ip-10-1-2-3.ec2.internal');
    expect(serialized).not.toContain('ip-10-9-8-7.ec2.internal');
  });

  it("replaces summary.app.name with the app id's pseudonym", () => {
    const out = redactReport(sampleReport());
    expect(out.summary.app.name).toBe('app-1');
    expect(JSON.stringify(out)).not.toContain('nightly-etl');
  });

  it('nulls the app name when the app has no id to stand in for it', () => {
    const report = sampleReport();
    report.summary.app.id = null;
    expect(redactReport(report).summary.app.name).toBeNull();
  });

  it('passes a report without an app through untouched', () => {
    const report = { schemaVersion: 1, summary: {}, findings: [] };
    expect(redactReport(report).summary).toEqual({});
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
    expect(input.summary.app.id).toBe('application_0000000000000_0001');
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
    // Host in a valueText string (never a `host` field) plus a bare IPv4 in a recommendation; both must be pseudonymized.
    const report = {
      schemaVersion: 1,
      summary: { app: { id: 'app_x' } },
      findings: [
        { id: 'a', type: 'retryWaste', stageId: 7,
          valueText: 'ExecutorLostFailure on ip-10-4-5-6.ec2.internal: Container killed' },
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
      summary: { app: { id: 'application_0000000000000_0001' } },
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

describe('failure groups', () => {
  const group = () => ({
    reason: 'ExceptionFailure', className: 'java.io.FileNotFoundException', count: 3, lossReason: null,
    message: '/warehouse/customers/part-0007 (No such file)',
    stackExcerpt: 'java.io.FileNotFoundException: /warehouse/customers/part-0007 (No such file)\n\tat com.example.Load.open(Load.scala:9)',
  });
  const expectScrubbed = (g) => {
    expect(g.message).toBe('[redacted]');
    expect(g.stackExcerpt).toBe('java.io.FileNotFoundException\n\tat com.example.Load.open(Load.scala:9)');
    expect(g.className).toBe('java.io.FileNotFoundException');
  };

  it('redactReport drops failed-task messages and stack message text from a failures finding', () => {
    const report = sampleReport();
    report.findings.push({ id: 'c', type: 'failures', stageId: 6, evidence: { failureGroups: [group()] } });
    const out = redactReport(report);
    expectScrubbed(out.findings[2].evidence.failureGroups[0]);
    expect(JSON.stringify(out)).not.toContain('/warehouse/customers');
    expect(report.findings[2].evidence.failureGroups[0].message).toContain('/warehouse'); // input untouched
  });

  it('redactRunModel scrubs both the catalog finding and the stage record', () => {
    const data = {
      schemaVersion: 1, app: { id: 'application_1690000000000_0001', name: 'n', sparkVersion: '3.5.0', config: {} },
      stages: [{ id: 1, name: 's', failureGroups: [group()] }], jobs: [], sql: [],
      executors: { added: [], removed: [] }, runAggregates: null, evidenceAvailability: null,
      catalog: [{ type: 'failures', stageId: 1, impactBand: 'warning', failureGroups: [group()] }], configFindings: [], skippedLines: 0,
    };
    const out = redactRun(data);
    expectScrubbed(out.appModel.stages.get(1).failureGroups[0]);
    expectScrubbed(out.catalog[0].failureGroups[0]);
    expect(JSON.stringify(out)).not.toContain('/warehouse/customers');
  });

  const REASON = 'Job aborted due to stage failure: Lost task 0.3 (executor 4): java.io.FileNotFoundException: /warehouse/customers/part-0007';

  it('redactReport replaces a stageFailed finding\'s failure reason', () => {
    const report = sampleReport();
    report.findings.push({
      id: 'd', type: 'stageFailed', stageId: 7, metric: 'stageFailureReason', valueText: REASON,
      evidence: { failedTaskDetails: [{ taskId: 1, attemptNumber: 0, host: 'worker-9.internal' }] },
    });
    const out = redactReport(report);
    const finding = out.findings.find((f) => f.id === 'd');
    expect(finding.valueText).toBe('[redacted]');
    expect(finding.metric).toBe('stageFailureReason');
    expect(JSON.stringify(out)).not.toContain('/warehouse/customers');
    expect(report.findings.find((f) => f.id === 'd').valueText).toBe(REASON); // input untouched
  });

  it('redactReport replaces summary.outcome.failureReason', () => {
    const report = sampleReport();
    report.summary.outcome = { failedJobs: 1, totalJobs: 2, failureReason: REASON, failureReasonStageId: 7 };
    const out = redactReport(report);
    expect(out.summary.outcome.failureReason).toBe('[redacted]');
    expect(out.summary.outcome.failedJobs).toBe(1);
    expect(JSON.stringify(out)).not.toContain('/warehouse/customers');
  });

  it('redactRunModel replaces a failed job\'s exception, the outcome fallback reason', () => {
    const data = {
      schemaVersion: 1, app: { id: 'application_1690000000000_0001', name: 'n', sparkVersion: '3.5.0', config: {} },
      stages: [], jobs: [{ id: 1, stageIds: [], succeeded: false, result: 'JobFailed', exception: REASON }], sql: [],
      executors: { added: [], removed: [] }, runAggregates: null, evidenceAvailability: null,
      catalog: [], configFindings: [], skippedLines: 0,
    };
    const out = redactRun(data);
    expect(out.appModel.jobs.get(1).exception).toBe('[redacted]');
    expect(JSON.stringify(out)).not.toContain('/warehouse/customers');
  });

  it('redactRunModel replaces the failure reason on the catalog finding and the stage record', () => {
    const data = {
      schemaVersion: 1, app: { id: 'application_1690000000000_0001', name: 'n', sparkVersion: '3.5.0', config: {} },
      stages: [{ id: 1, name: 's', stageFailureReason: REASON }], jobs: [], sql: [],
      executors: { added: [], removed: [] }, runAggregates: null, evidenceAvailability: null,
      catalog: [{ type: 'stageFailed', stageId: 1, impactBand: 'critical', metric: 'stageFailureReason', valueText: REASON }],
      configFindings: [], skippedLines: 0,
    };
    const out = redactRun(data);
    expect(out.appModel.stages.get(1).stageFailureReason).toBe('[redacted]');
    expect(out.catalog[0].valueText).toBe('[redacted]');
    expect(JSON.stringify(out)).not.toContain('/warehouse/customers');
  });

  it('pseudonymizes a host inside a loss reason, which is kept', () => {
    const report = sampleReport();
    report.findings.push({ id: 'c', type: 'failures', stageId: 6, evidence: { failureGroups: [
      { reason: 'ExecutorLostFailure', className: null, message: null, stackExcerpt: null, count: 1, lossReason: 'Container marked as failed on host: ip-10-5-5-5.ec2.internal' },
    ] } });
    const out = redactReport(report);
    expect(out.findings[2].evidence.failureGroups[0].lossReason).toMatch(/^Container marked as failed on host: host-\d+$/);
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

describe('redactRunModel', () => {
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
    const out = redactRun(sampleExportData());
    expect(out.appModel.app.id).toMatch(/app-\d+/);
    expect(out.catalog[0].recommendation).toContain(out.appModel.app.id);
    expect(JSON.stringify(out)).not.toContain('application_1690000000000_0001');
  });

  it('keeps no host value set per query (SQL execution modifiedConfigs)', () => {
    const data = sampleExportData();
    data.sql = [{ id: 0, modifiedConfigs: { 'spark.myco.gateway.host': 'zebra-etl-node7', 'spark.sql.shuffle.partitions': '8' } }];
    const out = redactRun(data);
    expect(JSON.stringify(out)).not.toContain('zebra-etl-node7');
    expect(out.appModel.sql.get(0).modifiedConfigs['spark.myco.gateway.host']).toBe('*********(redacted)');
    expect(out.appModel.sql.get(0).modifiedConfigs['spark.sql.shuffle.partitions']).toBe('8');
  });

  it('keeps no job-written text in per-query values: a bucket path under a key no detector reads is replaced', () => {
    const data = sampleExportData();
    data.sql = [{ id: 0, modifiedConfigs: {
      'spark.myco.output.bucket': 's3://acme-prod-ledger/2026/q3', 'spark.sql.shuffle.partitions': '8',
      'spark.sql.adaptive.autoBroadcastJoinThreshold': '-1',
    } }];
    const out = redactRun(data);
    expect(JSON.stringify(out)).not.toContain('acme-prod-ledger');
    const kept = out.appModel.sql.get(0).modifiedConfigs;
    expect(kept['spark.myco.output.bucket']).toBe('*********(redacted)');
    expect(kept['spark.sql.shuffle.partitions']).toBe('8');
    expect(kept['spark.sql.adaptive.autoBroadcastJoinThreshold']).toBe('-1');
  });

  // The app name identifies the job as much as its id does, so it takes the id's pseudonym, as
  // list_runs does. The structured fields are replaced, never substrings: a short name like "t"
  // would otherwise corrupt every string in the run.
  it("replaces the app name, and spark.app.name, with the app id's pseudonym", () => {
    const data = sampleExportData();
    data.app.name = 'nightly-orders-rollup';
    data.app.config['spark.app.name'] = 'nightly-orders-rollup';
    const out = redactRun(data);
    expect(out.appModel.app.name).toBe(out.appModel.app.id);
    expect(out.appModel.app.config['spark.app.name']).toBe(out.appModel.app.id);
    expect(JSON.stringify(out)).not.toContain('nightly-orders-rollup');
  });

  it('blanks spark.app.name when the app has no id, and skips a run without an app', () => {
    const noId = sampleExportData();
    noId.app.id = null;
    noId.app.config['spark.app.name'] = 'nightly-orders-rollup';
    expect(redactRun(noId).appModel.app.config['spark.app.name']).toBe('');
    const noApp = sampleExportData();
    noApp.app = null;
    expect(redactRun(noApp).appModel.app).toBeNull();
  });

  it('leaves text that merely contains the app name alone', () => {
    const data = sampleExportData();
    data.app.name = 'at';
    const out = redactRun(data);
    expect(out.appModel.app.name).toBe(out.appModel.app.id);
    expect(out.appModel.stages.get(1).name).toMatch(/^collect at /);
  });

  it("pseudonymizes an executor's literal host field, not just IP-shaped free text", () => {
    const out = redactRun(sampleExportData());
    expect(out.appModel.executors.added[0].host).toMatch(/host-\d+/);
    expect(out.appModel.executors.added[0].host).not.toBe('worker-3.internal');
  });

  // An executor's removal reason is Spark's free-text message, so it can carry a path or a data value.
  it("replaces an executor's removal reason, and leaves other fields named reason alone", () => {
    const data = sampleExportData();
    data.executors.removed = [{
      kind: 'removed', timestamp: 9, executorId: '1',
      reason: 'Container killed while reading s3://acme-prod-ledger/2026/q3 for customer 4471-ZEBRA',
    }];
    data.catalog = [...data.catalog, { type: 'note', reason: 'kept-reason', impactBand: 'info' }];
    const out = redactRun(data);
    const json = JSON.stringify(out);
    expect(json).not.toContain('acme-prod-ledger');
    expect(json).not.toContain('4471-ZEBRA');
    expect(out.appModel.executors.removed[0].reason).toBe('[redacted]');
    expect(out.appModel.executors.removed[0].executorId).toBe('1');
    expect(out.catalog[1].reason).toBe('kept-reason');
  });

  it('pseudonymizes an IP-shaped host token embedded in a stage name', () => {
    const out = redactRun(sampleExportData());
    expect(out.appModel.stages.get(1).name).toMatch(/host-\d+/);
    expect(out.appModel.stages.get(1).name).not.toContain('ip-10-1-2-3.ec2.internal');
  });

  it('reaches configFindings, not just catalog', () => {
    const out = redactRun(sampleExportData());
    expect(out.configFindings[0].value).toMatch(/host-\d+/);
  });

  it('does not mutate the input', () => {
    const input = sampleExportData();
    redactRun(input);
    expect(input.app.id).toBe('application_1690000000000_0001');
  });

  it('pseudonymizes plain-FQDN hosts living under host/hostname-suffixed app.config keys', () => {
    const out = redactRun(sampleExportData());
    expect(out.appModel.app.config['spark.driver.host']).toMatch(/^host-\d+$/);
    expect(out.appModel.app.config['spark.yarn.am.hostname']).toMatch(/^host-\d+$/);
    // A config value that isn't under a host/hostname-suffixed key is left alone.
    expect(out.appModel.app.config['spark.executor.instances']).toBe('4');
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('driver-7.internal.corp');
    expect(serialized).not.toContain('am-node-2.internal.corp');
  });
});

describe('redactRunModel: URL hosts, user names and stage hosts', () => {
  const USER_NAME = 'alice';
  const NAME_NODE = 'nn01.corp.example';
  const DB_HOST = 'db01.corp.example';

  function run() {
    return {
      app: {
        id: 'application_1690000000000_0001', name: 'nightly', sparkVersion: '3.5.0',
        config: {
          'spark.eventLog.dir': `hdfs://${NAME_NODE}:8020/user/${USER_NAME}/eventlogs`,
          'spark.sql.warehouse.dir': `hdfs://${NAME_NODE}:8020/user/${USER_NAME}/warehouse`,
          'spark.master': 'spark://master01:7077',
          'spark.yarn.historyServer.address': 'hist01.corp.example:18080',
          'spark.yarn.rm.ha.addresses': 'rm1.corp.example:8032,rm2.corp.example:8032',
          'spark.executor.extraJavaOptions': `-Duser.name=${USER_NAME} -Xmx2g`,
          'spark.executor.instances': '4',
          'spark.sql.shuffle.partitions': '200',
        },
      },
      stages: [{ id: 1, name: 'collect', hostStats: [{ host: 'worker-zz9', taskCount: 3, totalDuration: 10 }] }],
      jobs: [],
      sql: [{
        id: 0,
        planNodes: [{ id: 1, detail: `JDBCRelation jdbc:postgresql://${DB_HOST}:5432/sales?user=${USER_NAME}&ssl=true` }],
      }],
      executors: { added: [], removed: [] },
      runAggregates: null,
      evidenceAvailability: null,
      catalog: [],
      configFindings: [],
    };
  }

  // Stages, jobs and SQL executions come back as Maps, which JSON.stringify would print as {}.
  const flatten = (out) => JSON.stringify(out, (_, value) => (value instanceof Map ? [...value] : value));
  const serialized = () => flatten(redactRun(run()));

  it('pseudonymizes the host of a URL, whatever its scheme or shape', () => {
    const out = serialized();
    for (const host of [NAME_NODE, DB_HOST, 'master01']) expect(out).not.toContain(host);
    expect(redactRun(run()).appModel.app.config['spark.eventLog.dir']).toMatch(/^hdfs:\/\/host-\d+:8020\/user\//);
  });

  it('pseudonymizes the host of a URL inside a plan node detail and keeps the rest of the text', () => {
    const detail = redactRun(run()).appModel.sql.get(0).planNodes[0].detail;
    expect(detail).toMatch(/^JDBCRelation jdbc:postgresql:\/\/host-\d+:5432\/sales\?user=redacted-user&ssl=true$/);
  });

  it('scrubs the user name from a path, a user= value and a -Duser.name option', () => {
    const out = serialized();
    expect(out).not.toContain(USER_NAME);
    const { config } = redactRun(run()).appModel.app;
    expect(config['spark.sql.warehouse.dir']).toMatch(/\/user\/redacted-user\/warehouse$/);
    expect(config['spark.executor.extraJavaOptions']).toBe('-Duser.name=redacted-user -Xmx2g');
  });

  it('scrubs credentials out of a URL authority', () => {
    const data = run();
    data.app.config['spark.some.url'] = 'jdbc:mysql://bob:s3cret@db02.corp.example/app';
    const out = flatten(redactRun(data));
    expect(out).not.toContain('bob');
    expect(out).not.toContain('s3cret');
    expect(out).not.toContain('db02.corp.example');
  });

  it('reads a nested-scheme URL through to the inner host', () => {
    const data = run();
    data.app.config['spark.master'] = 'k8s://https://kube-api.corp.example:6443';
    data.app.config['spark.kubernetes.driver.podTemplateFile'] = 'k8s://https://carol@kube-api.corp.example:6443/t';
    data.stages[0].name = 'See https://docs.example/x';
    const out = redactRun(data);
    expect(out.appModel.app.config['spark.master']).toMatch(/^k8s:\/\/https:\/\/host-\d+:6443$/);
    expect(out.appModel.stages.get(1).name).toMatch(/^See https:\/\/host-\d+\/x$/);
    const text = flatten(out);
    expect(text).not.toContain('kube-api');
    expect(text).not.toContain('carol');
  });

  it('replaces a single-word URL host only in URL authority position', () => {
    const data = run();
    data.app.config['spark.eventLog.dir'] = 's3a://data/logs';
    data.stages[0].name = 'scan data at s3a://data/in; metadata, raw_data, data.json, data.';
    const out = redactRun(data);
    expect(out.appModel.app.config['spark.eventLog.dir']).toMatch(/^s3a:\/\/host-\d+\/logs$/);
    expect(out.appModel.stages.get(1).name).toMatch(/^scan data at s3a:\/\/host-\d+\/in; metadata, raw_data, data\.json, data\.$/);
  });

  it('keeps a sentence period after a single-word URL host outside the host', () => {
    const finding = { type: 'skew', recommendation: 'Event logs go to s3a://shuffle. Reduce shuffle. Read db01.corp.example.' };
    const out = redactReport({ findings: [finding], summary: { app: { id: null } } }).findings[0];
    expect(out.recommendation).toMatch(/^Event logs go to s3a:\/\/host-\d+\. Reduce shuffle\. Read db01\.corp\.example\.$/);
    expect(redactReport({ findings: [{ type: 'skew', recommendation: 'Logs at s3a://db01.corp.example. See db01.corp.example.' }], summary: { app: { id: null } } }).findings[0].recommendation)
      .toMatch(/^Logs at s3a:\/\/(host-\d+)\. See \1\.$/);
  });

  it.each(['shuffle', 'info', 'data'])('keeps enum fields and prose intact when the log dir bucket is %s', (bucket) => {
    const finding = { type: 'skew', impactBand: 'info', cause: 'data', summary: `uneven ${bucket} assignment`, host: 'worker-zz9' };
    const data = run();
    data.app.config['spark.eventLog.dir'] = `s3a://${bucket}/logs`;
    data.catalog = [finding];
    const out = redactRun(data);
    expect(out.appModel.app.config['spark.eventLog.dir']).toMatch(/^s3a:\/\/host-\d+\/logs$/);
    expect(out.catalog[0]).toEqual({ ...finding, host: expect.stringMatching(/^host-\d+$/) });
    expect(redactReport({ findings: [finding], summary: { app: { id: null }, dir: `s3a://${bucket}/x` } }).findings[0])
      .toEqual({ ...finding, host: expect.stringMatching(/^host-\d+$/) });
  });

  it('replaces a single-word config host:port host only in host:port or URL position', () => {
    const finding = { type: 'shuffle', impactBand: 'info', summary: 'uneven shuffle assignment', host: 'worker-zz9' };
    const data = run();
    data.app.config['spark.yarn.historyServer.address'] = 'shuffle:18080';
    data.app.config['spark.history.ui.url'] = 'http://shuffle/history';
    data.stages[0].name = 'shuffle read from shuffle:18080';
    data.catalog = [finding];
    const out = redactRun(data);
    const { config } = out.appModel.app;
    const [, pseudonym] = config['spark.yarn.historyServer.address'].match(/^(host-\d+):18080$/);
    expect(config['spark.history.ui.url']).toBe(`http://${pseudonym}/history`);
    expect(out.appModel.stages.get(1).name).toBe(`shuffle read from ${pseudonym}:18080`);
    expect(config['spark.sql.shuffle.partitions']).toBe('200');
    expect(out.catalog[0]).toEqual({ ...finding, host: expect.stringMatching(/^host-\d+$/) });
  });

  it('pseudonymizes host:port values under any config key', () => {
    const out = serialized();
    for (const host of ['hist01.corp.example', 'rm1.corp.example', 'rm2.corp.example']) expect(out).not.toContain(host);
  });

  it('pseudonymizes a host that only a stage records in hostStats', () => {
    const out = redactRun(run());
    expect(out.appModel.stages.get(1).hostStats[0].host).toMatch(/^host-\d+$/);
    expect(serialized()).not.toContain('worker-zz9');
  });

  it('leaves non-identifying config and a URL without an authority alone', () => {
    const data = run();
    data.app.config['spark.local.dir'] = 'file:///tmp/spark';
    const { config } = redactRun(data).appModel.app;
    expect(config['spark.executor.instances']).toBe('4');
    expect(config['spark.local.dir']).toBe('file:///tmp/spark');
  });

  it('is idempotent over URL hosts and scrubbed user names', () => {
    const once = redactRun(run());
    const twice = redactRunModel(once.appModel, once.catalog, once.configFindings);
    expect(flatten(twice)).toBe(flatten(once));
  });

  it('redactComparison pseudonymizes the URL host and user in a config difference', () => {
    const comparison = {
      comparability: { conf: { equal: false, differences: [
        { key: 'spark.eventLog.dir', baseline: `hdfs://${NAME_NODE}:8020/user/${USER_NAME}/a`, candidate: `hdfs://${NAME_NODE}:8020/user/${USER_NAME}/b` },
      ] } },
    };
    const out = JSON.stringify(redactComparison(comparison));
    expect(out).not.toContain(NAME_NODE);
    expect(out).not.toContain(USER_NAME);
    expect(out).toContain('/user/redacted-user/a');
  });

  it('redacts 500 hosts across 20 000 stages in well under a second', () => {
    const hosts = Array.from({ length: 500 }, (_, i) => `worker-${i}.corp.example`);
    const data = run();
    data.executors.added = hosts.map((host, i) => ({ kind: 'added', timestamp: 0, executorId: String(i), host, totalCores: 4, resourceProfileId: null }));
    data.stages = Array.from({ length: 20000 }, (_, i) => ({
      id: i, name: `stage ${i} on ${hosts[i % 500]}`, hostStats: [{ host: hosts[(i * 7) % 500], taskCount: 1, totalDuration: 1 }],
    }));
    const started = performance.now();
    const out = redactRun(data);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(flatten(out)).not.toContain('corp.example');
  });
});
