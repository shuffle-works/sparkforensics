import { describe, it, expect } from 'vitest';
import { buildEvidenceReport } from '../src/evidence-report.js';
import { makeStage } from './fixtures/stage-app-fixtures.js';
import { PER_STAGE_CHECK_TYPES } from '../src/check-coverage.ts';

function fixture() {
  return {
    app: {
      id: 'application_0000000000000_0001', name: 'nightly-etl',
      startTime: 0, endTime: 5000, sparkVersion: '3.4.0', config: {},
    },
    stages: new Map([
      [1, makeStage({ id: 1, taskDurationP50: 100, taskDurationP95: 600 })],   // skew critical
      [2, makeStage({ id: 2, shuffleReadBytes: 2 * 1024 * 1024 * 1024, fetchWaitTime: 10000 })], // shuffle critical
    ]),
    executors: { added: [], removed: [] },
    sql: new Map(),
    jobs: new Map(),
    runAggregates: null,
    evidenceAvailability: {
      schemaVersion: 1,
      entries: [{ key: 'sqlPlan', state: 'notEmitted', reasonCode: 'noResolvedSqlPlan', summary: 'No resolved SQL plan.' }],
    },
  };
}

describe('buildEvidenceReport', () => {
  it('leaves an undefined finding field out of the evidence instead of printing "undefined"', () => {
    // 64 MB spilled clears no spill-magnitude tier, so the spill finding's spillMagnitude is undefined.
    const fx = fixture();
    fx.stages.set(3, makeStage({ id: 3, memoryBytesSpilled: 64 * 1024 * 1024 }));
    const { markdown, json } = buildEvidenceReport(fx);
    const spill = json.findings.find((f) => f.type === 'spill');
    expect(spill).toBeTruthy();
    expect('spillMagnitude' in spill.evidence).toBe(false);
    expect(markdown).not.toContain('undefined');
  });

  it('returns { markdown, json } with a documented numeric schemaVersion', () => {
    const { markdown, json } = buildEvidenceReport(fixture());
    expect(typeof markdown).toBe('string');
    expect(typeof json.schemaVersion).toBe('number');
    expect(json.schemaVersion).toBe(4);
  });

  it('carries a run summary + findings with the required per-row fields', () => {
    const { json } = buildEvidenceReport(fixture());
    expect(json.summary).toBeTruthy();
    expect(json.summary.app.id).toBe('application_0000000000000_0001');
    expect(Array.isArray(json.findings)).toBe(true);
    expect(json.findings.length).toBeGreaterThan(0);
    for (const row of json.findings) {
      expect(typeof row.id).toBe('string');
      expect(typeof row.type).toBe('string');
      expect(typeof row.tag).toBe('string');
      expect(typeof row.name).toBe('string');
      expect(row).toHaveProperty('impactBand');
      expect(row).toHaveProperty('recommendation');
      expect(row).toHaveProperty('evidence');
      expect(typeof row.detectorVersion).toBe('number');
    }
  });

  it('surfaces confidence/validation when the detector emits them', () => {
    const fx = fixture();
    // A low-confidence spill finding carries confidence + validationRequired.
    fx.stages.set(3, makeStage({ id: 3, memoryBytesSpilled: 100 * 1024 * 1024 }));
    const { json } = buildEvidenceReport(fx);
    const spill = json.findings.find((r) => r.type === 'spill');
    expect(spill.confidence).toBeTruthy();
    expect(spill.validationRequired).toBeTruthy();
  });

  it('excludes planNodeIds from the evidence dump: view-layer graph ids, not human-readable, unlike stageIds', () => {
    const readNode = {
      id: 'node-1', name: 'Scan parquet', detail: '', children: [],
      metrics: [
        { name: 'number of files read', value: 150, metricType: 'sum' },
        { name: 'size of files read', value: 150 * 1024 * 1024, metricType: 'sum' },
      ],
    };
    const planTree = { name: 'Project', detail: '', metrics: [], children: [readNode] };
    const fx = fixture();
    fx.sql = new Map([[1, {
      id: 1, description: '', startTime: 0, endTime: 100, stageIds: [], planTree,
    }]]);

    const { json, markdown } = buildEvidenceReport(fx);
    const row = json.findings.find((r) => r.type === 'smallFiles');

    expect(row).toBeTruthy();
    expect(row.evidence).not.toHaveProperty('planNodeIds');
    // stageIds (plural, non-core) is real evidence and must still come through.
    expect(row.evidence).toHaveProperty('stageIds');
    expect(markdown).not.toContain('planNodeIds');
  });

  it('includes the EvidenceAvailability ledger from the appModel', () => {
    const { json } = buildEvidenceReport(fixture());
    expect(json.evidenceAvailability).toEqual(fixture().evidenceAvailability);
  });

  it('embeds the detector catalog so thresholds/versions travel with the report', () => {
    const { json } = buildEvidenceReport(fixture());
    expect(Array.isArray(json.detectors)).toBe(true);
    expect(json.detectors.length).toBeGreaterThan(0);
    for (const d of json.detectors) {
      expect(typeof d.type).toBe('string');
      expect(typeof d.version).toBe('number');
      expect(typeof d.scope).toBe('string');
      expect(d).toHaveProperty('thresholds');
      expect(d).toHaveProperty('docAnchor');
    }
  });

  it('never leaks raw task records (deep-walk, not just known key names)', () => {
    const { json } = buildEvidenceReport(fixture());
    // A per-task array could serialize under any key, so scan every array for
    // task-shaped objects rather than trusting literal key names.
    const isTaskShaped = (o) =>
      o !== null && typeof o === 'object' &&
      ['taskId', 'attemptId', 'launchTime'].some((k) => k in o);
    const walk = (node) => {
      if (Array.isArray(node)) {
        expect(node.some(isTaskShaped), 'report must not embed task-shaped records').toBe(false);
        node.forEach(walk);
      } else if (node && typeof node === 'object') {
        Object.values(node).forEach(walk);
      }
    };
    walk(json);
  });

  it('is byte-stable and key-order-stable, raw and redacted', () => {
    // Self-compare guards randomness/timestamps; pinning key order guards an
    // accidental reordering both self-compares would miss.
    const raw = buildEvidenceReport(fixture()).json;
    expect(JSON.stringify(raw)).toBe(JSON.stringify(buildEvidenceReport(fixture()).json));
    expect(Object.keys(raw)).toEqual([
      'schemaVersion', 'summary', 'evidenceAvailability', 'detectors', 'findings',
      'recommendations', 'cleanChecks', 'notRunChecks',
    ]);
    // Core construction order (optional confidence/validation/docAnchor trail it).
    expect(Object.keys(raw.findings[0]).slice(0, 11)).toEqual([
      'id', 'type', 'name', 'tag', 'impactBand', 'stageId', 'metric', 'value',
      'recommendation', 'detectorVersion', 'evidence',
    ]);
    // actionLabel is always present (unlike confidence/validationRequired/docAnchor/
    // impactEstimate, which only appear when the detector emitted them).
    expect(Object.keys(raw.findings[0])).toContain('actionLabel');
    const red = buildEvidenceReport(fixture(), { redact: true }).json;
    expect(JSON.stringify(red)).toBe(JSON.stringify(buildEvidenceReport(fixture(), { redact: true }).json));
    expect(Object.keys(red)).toEqual(Object.keys(raw));
  });

  it('markdown contains every finding name', () => {
    const { markdown, json } = buildEvidenceReport(fixture());
    for (const row of json.findings) {
      expect(markdown).toContain(row.name);
    }
  });

  it('markdown carries the AC3 field set: detector version, evidence, thresholds', () => {
    const fx = fixture();
    // gc findings carry evidence.direction; ensure it reaches the Markdown.
    const { markdown } = buildEvidenceReport(fx);
    expect(markdown).toContain('detector version: 1');
    expect(markdown).toMatch(/- evidence:\n {2}- direction: low/);
    expect(markdown).toContain('## Detectors');
    expect(markdown).toContain('skew (v1, stage), thresholds:');
  });

  it('with { redact:true } routes output through redactReport', () => {
    const { markdown, json } = buildEvidenceReport(fixture(), { redact: true });
    expect(json.summary.app.id).toBe('app-1');
    expect(JSON.stringify(json)).not.toContain('application_0000000000000_0001');
    expect(markdown).not.toContain('application_0000000000000_0001');
  });

  it('surfaces impactEstimate as a first-class FindingRow column, not buried in evidence', () => {
    const { json } = buildEvidenceReport(fixture());
    const findingWithEstimate = json.findings.find((f) => f.impactEstimate != null);
    expect(findingWithEstimate).toBeDefined();
    expect(findingWithEstimate.impactEstimate).toHaveProperty('basis');
    expect(findingWithEstimate.impactEstimate).toHaveProperty('estimateMethod');
    // wallClock is null for 'resourceOnly'/'informational' findings, {low, high} otherwise
    const { wallClock } = findingWithEstimate.impactEstimate;
    if (wallClock !== null) {
      expect(typeof wallClock.low).toBe('number');
      expect(typeof wallClock.high).toBe('number');
    }
    // and NOT duplicated into the evidence catch-all bag
    expect(findingWithEstimate.evidence).not.toHaveProperty('impactEstimate');
  });

  it('markdown carries impactEstimate, not just the JSON output', () => {
    const { markdown, json } = buildEvidenceReport(fixture());
    const withEstimate = json.findings.filter((f) => f.impactEstimate != null);
    expect(withEstimate.length).toBeGreaterThan(0);
    // 'informational'-basis estimates have no wallClock/rawWaste to print;
    // only the quantifiable ones are expected to produce an `- impact:` line.
    const renderable = withEstimate.filter(
      (f) => f.impactEstimate.wallClock != null || f.impactEstimate.rawWaste != null,
    );
    expect(renderable.length).toBeGreaterThan(0);
    for (const f of renderable) {
      expect(markdown).toContain(`estimateMethod: ${f.impactEstimate.estimateMethod}`);
    }
    const impactLines = markdown.split('\n').filter((l) => l.startsWith('- impact:'));
    expect(impactLines.length).toBe(renderable.length);
    // Markdown is read outside the space-constrained web UI, so the wall-clock
    // estimate prefix reads as a full word rather than the "Est." abbreviation.
    const wallClockLines = impactLines.filter((l) => /\bEstimated\b/.test(l));
    expect(wallClockLines.length).toBeGreaterThan(0);
    expect(markdown).not.toContain('Est. ');
  });

  // Redaction must reach a slowHost's host where the builder nests it
  // (evidence.host + the recommendation free text), not a never-emitted f.host.
  it('with { redact:true } removes host names nested in evidence + free text', () => {
    const badHost = 'ip-10-1-2-3.ec2.internal';
    // 3 fast hosts + 1 slow host (ratio 3) => a slowHost finding. Durations must
    // clear the detector's 1s absolute-magnitude floor or they'd be suppressed.
    const hostStats = [
      { host: 'ip-10-9-9-1.ec2.internal', taskCount: 20, totalDuration: 200000 },
      { host: 'ip-10-9-9-2.ec2.internal', taskCount: 20, totalDuration: 200000 },
      { host: 'ip-10-9-9-3.ec2.internal', taskCount: 20, totalDuration: 200000 },
      { host: badHost, taskCount: 20, totalDuration: 600000 },
    ];
    const fx = fixture();
    fx.stages.set(9, makeStage({ id: 9, taskCount: 80, hostStats }));

    const raw = buildEvidenceReport(fx).json;
    const slowRaw = raw.findings.find((r) => r.type === 'slowHost' && r.evidence?.host === badHost);
    expect(slowRaw, 'fixture must emit a slowHost with the host in evidence.host').toBeTruthy();

    const { markdown, json } = buildEvidenceReport(fx, { redact: true });
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain(badHost);
    expect(markdown).not.toContain(badHost);
    const slow = json.findings.find((r) => r.type === 'slowHost' && r.stageId === 9);
    expect(slow.evidence.host).toMatch(/^host-\d+$/);
    expect(slow.recommendation).not.toContain(badHost);
  });

  describe('failures finding', () => {
    const failingFixture = () => {
      const fx = fixture();
      fx.stages.set(7, makeStage({
        id: 7, taskCount: 100, failedTasks: 30,
        failureReasons: [{ reason: 'ExceptionFailure', count: 30 }],
        failureGroups: [{
          reason: 'ExceptionFailure', className: 'java.lang.NumberFormatException', count: 30, lossReason: null,
          message: 'For input string: "4111-1111"',
          stackExcerpt: 'java.lang.NumberFormatException: For input string: "4111-1111"\n\tat com.example.Parse.row(Parse.scala:3)',
        }],
      }));
      return fx;
    };

    it('renders each distinct error with its stack excerpt as a code block', () => {
      const { markdown } = buildEvidenceReport(failingFixture());
      expect(markdown).toContain('(dominant error: java.lang.NumberFormatException)');
      expect(markdown).toContain('    - 30 task(s): java.lang.NumberFormatException: For input string: "4111-1111"');
      expect(markdown).toContain('          \tat com.example.Parse.row(Parse.scala:3)');
    });

    it('with { redact:true } leaves no exception message in the JSON or the Markdown', () => {
      const { markdown, json } = buildEvidenceReport(failingFixture(), { redact: true });
      expect(JSON.stringify(json)).not.toContain('4111-1111');
      expect(markdown).not.toContain('4111-1111');
      expect(markdown).toContain('30 task(s): java.lang.NumberFormatException: [redacted]');
    });
  });

  describe('actionLabel', () => {
    it('gives every finding row a non-empty actionLabel', () => {
      const { json } = buildEvidenceReport(fixture());
      expect(json.findings.length).toBeGreaterThan(0);
      for (const row of json.findings) {
        expect(typeof row.actionLabel).toBe('string');
        expect(row.actionLabel.length).toBeGreaterThan(0);
      }
      const skew = json.findings.find((r) => r.type === 'skew');
      expect(skew.actionLabel).toBe('Fix task skew');
    });

    it('markdown prints an action line for every finding', () => {
      const { markdown, json } = buildEvidenceReport(fixture());
      for (const row of json.findings) {
        expect(markdown).toContain(`- action: ${row.actionLabel}`);
      }
    });
  });

  // Adds a stageShape/lowParallelism stage (resource kind) and a non-empty
  // app.config (configAudit, count kind) to fixture()'s time-kind findings, so
  // one fixture exercises all three RecommendationRow kinds.
  function fixtureWithVariety() {
    const fx = fixture();
    fx.app.config = { 'spark.executor.memory': '4g' };
    fx.stages.set(3, makeStage({
      id: 3, taskCount: 1, executorStats: [{}, {}, {}],
      taskDurationP50: 100, taskDurationP95: 100, taskDurationMax: 100,
    }));
    return fx;
  }

  describe('recommendations', () => {
    it('is an additive top-level array', () => {
      const { json } = buildEvidenceReport(fixture());
      expect(json.schemaVersion).toBe(4);
      expect(Array.isArray(json.recommendations)).toBe(true);
      expect(json.recommendations.length).toBeGreaterThan(0);
    });

    it('covers time/resource/count kinds with their documented per-kind fields', () => {
      const { json } = buildEvidenceReport(fixtureWithVariety());
      const byType = Object.fromEntries(json.recommendations.map((r) => [r.type, r]));

      const time = byType.tinyTask;
      expect(time).toBeTruthy();
      expect(time.kind).toBe('time');
      expect(typeof time.stageCount).toBe('number');
      expect(typeof time.recoverableMsHigh).toBe('number');
      expect(typeof time.impact).toBe('string');
      expect(time.unit).toBeUndefined();
      expect(time.byImpactBand).toBeUndefined();

      const resource = byType.stageShape;
      expect(resource).toBeTruthy();
      expect(resource.kind).toBe('resource');
      expect(resource.unit).toBe('coreMs');
      expect(typeof resource.total).toBe('number');
      expect(typeof resource.impact).toBe('string');
      expect(resource.recoverableMsHigh).toBeUndefined();
      expect(resource.byImpactBand).toBeUndefined();

      const count = byType.configAudit;
      expect(count).toBeTruthy();
      expect(count.kind).toBe('count');
      expect(count.impact).toBeNull();
      expect(count.byImpactBand).toEqual({ info: 1 });
      expect(count.unit).toBeUndefined();
      expect(count.recoverableMsHigh).toBeUndefined();

      for (const r of json.recommendations) {
        expect(typeof r.type).toBe('string');
        expect(typeof r.tag).toBe('string');
        expect(typeof r.actionLabel).toBe('string');
        expect(typeof r.findingCount).toBe('number');
        expect(Array.isArray(r.findingIds)).toBe(true);
        expect(r.findingIds.every((id) => typeof id === 'string')).toBe(true);
      }
    });

    it('orders every time-kind row ahead of resource/count rows, time rows by recoverableMsHigh descending', () => {
      const { json } = buildEvidenceReport(fixtureWithVariety());
      const kinds = json.recommendations.map((r) => r.kind);
      const firstNonTimeIdx = kinds.findIndex((k) => k !== 'time');
      expect(firstNonTimeIdx).toBeGreaterThan(0);
      expect(kinds.slice(0, firstNonTimeIdx).every((k) => k === 'time')).toBe(true);
      const timeRows = json.recommendations.filter((r) => r.kind === 'time');
      for (let i = 1; i < timeRows.length; i++) {
        expect(timeRows[i - 1].recoverableMsHigh).toBeGreaterThanOrEqual(timeRows[i].recoverableMsHigh);
      }
    });

    it('excludes incompleteRun and the memoryBand/dataUnavailable memoryUtilization variant, matching FixTheseFirst', () => {
      const { json } = buildEvidenceReport(fixture());
      expect(json.recommendations.some((r) => r.type === 'incompleteRun')).toBe(false);
      expect(json.recommendations.some((r) => r.type === 'memoryUtilization')).toBe(false);
      // The finding itself still shows up in the full `findings` list; it's
      // only excluded from the ranked recommendation rollup.
      expect(json.findings.some((f) => f.type === 'memoryUtilization')).toBe(true);
    });

    it('picks actionLabel/findingIds from the group\'s representative (best-ranked) member', () => {
      const { json } = buildEvidenceReport(fixture());
      const skewRow = json.recommendations.find((r) => r.type === 'skew');
      expect(skewRow.actionLabel).toBe('Fix task skew');
      expect(skewRow.findingIds).toHaveLength(1);
    });

    it('markdown lists a "Fix these first" section before Findings', () => {
      const { markdown, json } = buildEvidenceReport(fixture());
      expect(markdown).toContain(`## Fix these first (${json.recommendations.length})`);
      expect(markdown.indexOf('## Fix these first')).toBeLessThan(markdown.indexOf('## Findings'));
      json.recommendations.forEach((r, i) => {
        expect(markdown).toContain(`${i + 1}. [${r.tag}] ${r.actionLabel}`);
      });
    });
  });

  describe('cleanChecks', () => {
    it('lists detector types with zero findings this run, deduped, with a threshold summary', () => {
      const { json } = buildEvidenceReport(fixture());
      expect(Array.isArray(json.cleanChecks)).toBe(true);
      const types = json.cleanChecks.map((c) => c.type);
      expect(new Set(types).size).toBe(types.length); // configAudit's 4 DETECTORS entries collapse to one
      expect(types).toContain('spill'); // never fired in this fixture
      expect(types).not.toContain('skew'); // fired
      for (const entry of json.cleanChecks) {
        expect(typeof entry.tag).toBe('string');
        expect(typeof entry.thresholdSummary).toBe('string');
      }
    });

    it('includes the always-mounted reference types (utilization, coreLocality) when they have zero findings, unlike Alerts.tsx', () => {
      const { json } = buildEvidenceReport(fixture());
      const types = json.cleanChecks.map((c) => c.type);
      expect(types).toContain('utilization');
      expect(types).toContain('coreLocality');
    });

    it('moves every per-stage check to notRunChecks when no stage finished', () => {
      const fx = fixture();
      fx.stages = new Map([[1, makeStage({ id: 1, completedAt: undefined })]]);
      const { json, markdown } = buildEvidenceReport(fx);
      const notRun = json.notRunChecks.map((c) => c.type);
      // A per-stage type either fired on the unfinished stage or could not run; none passed.
      for (const type of ['skew', 'spill', 'stageFailed', 'straggler']) expect(notRun).toContain(type);
      const clean = json.cleanChecks.map((c) => c.type);
      for (const type of PER_STAGE_CHECK_TYPES) expect(clean).not.toContain(type);
      expect(json.notRunChecks.find((c) => c.type === 'skew').reason).toMatch(/No stage in this log recorded an end/);
      expect(json.summary.clean).toBe(false);
      expect(markdown).toContain(`## Not checked on this log (${json.notRunChecks.length})`);
      expect(markdown).toContain('- [SKEW] skew: No stage in this log recorded an end');
      expect(markdown.indexOf('## Not checked on this log')).toBeLessThan(markdown.indexOf('## Clean checks'));
    });

    it('moves the run-span checks to notRunChecks on a log with no end-of-run record', () => {
      const fx = fixture();
      fx.app = { ...fx.app, endTime: null };
      const { json } = buildEvidenceReport(fx);
      const notRun = new Map(json.notRunChecks.map((c) => [c.type, c.reason]));
      for (const type of ['utilization', 'autoscalingChurn']) {
        expect(notRun.get(type)).toMatch(/no end-of-run record/);
      }
      expect(json.cleanChecks.map((c) => c.type)).not.toContain('utilization');
    });

    it('counts only actionable findings in the actionable summary fields', () => {
      const fx = fixture();
      fx.app = { ...fx.app, endTime: null };
      const { json, markdown } = buildEvidenceReport(fx);
      const s = json.summary;
      expect(json.findings.some((f) => f.type === 'incompleteRun')).toBe(true);
      expect(s.actionableFindingCount).toBe(json.findings.filter((f) => f.type !== 'incompleteRun' && f.evidence.dataUnavailable !== true).length);
      expect(s.actionableFindingCount).toBeLessThan(s.findingCount);
      const sum = s.actionableImpactBandCounts.critical + s.actionableImpactBandCounts.warning + s.actionableImpactBandCounts.info;
      expect(sum).toBe(s.actionableFindingCount);
      expect(markdown).toContain(`- Findings to act on: ${s.actionableFindingCount} (`);
    });

    it('markdown lists clean checks after the Detectors section', () => {
      const { markdown, json } = buildEvidenceReport(fixture());
      expect(markdown).toContain(`## Clean checks (${json.cleanChecks.length})`);
      expect(markdown.indexOf('## Detectors')).toBeLessThan(markdown.indexOf('## Clean checks'));
      for (const entry of json.cleanChecks) {
        expect(markdown).toContain(`- [${entry.tag}] ${entry.type}: ${entry.thresholdSummary}`);
      }
    });
  });

  describe('findingsFilter', () => {
    // fixtureWithVariety() findings: shuffle (critical, stage 2), skew
    // (critical, stage 1), tinyTask×2 (critical, stages 1+2), configAudit
    // (info, no stage), gc×3 (info, stages 1/2/3), memoryUtilization (info,
    // no stage), stageShape (info, stage 3). 10 total, 4 critical / 6 info.
    it('is a no-op when omitted: unaffected callers see the full findings array', () => {
      const filtered = buildEvidenceReport(fixtureWithVariety()).json;
      const unfiltered = buildEvidenceReport(fixtureWithVariety(), {}).json;
      expect(filtered.findings).toEqual(unfiltered.findings);
      expect(filtered.findings.length).toBe(10);
    });

    it('narrows findings by impactBand alone, leaving recommendations/cleanChecks/summary counts full', () => {
      const full = buildEvidenceReport(fixtureWithVariety()).json;
      const { json } = buildEvidenceReport(fixtureWithVariety(), { findingsFilter: { impactBand: ['critical'] } });
      expect(json.findings.length).toBe(4);
      expect(json.findings.every((f) => f.impactBand === 'critical')).toBe(true);
      expect(json.recommendations).toEqual(full.recommendations);
      expect(json.cleanChecks).toEqual(full.cleanChecks);
      expect(json.summary.findingCount).toBe(full.summary.findingCount);
      expect(json.summary.impactBandCounts).toEqual(full.summary.impactBandCounts);
    });

    it('narrows findings by type alone', () => {
      const { json } = buildEvidenceReport(fixtureWithVariety(), { findingsFilter: { type: ['skew'] } });
      expect(json.findings).toHaveLength(1);
      expect(json.findings[0].type).toBe('skew');
    });

    it('narrows findings by stageId alone, dropping stageId: null rows', () => {
      const { json } = buildEvidenceReport(fixtureWithVariety(), { findingsFilter: { stageId: 1 } });
      expect(json.findings.length).toBeGreaterThan(0);
      expect(json.findings.every((f) => f.stageId === 1)).toBe(true);
    });

    it('combines all three dimensions (AND, not OR)', () => {
      const { json } = buildEvidenceReport(fixtureWithVariety(), {
        findingsFilter: { impactBand: ['critical'], stageId: 1 },
      });
      expect(json.findings.length).toBe(2);
      for (const f of json.findings) {
        expect(f.impactBand).toBe('critical');
        expect(f.stageId).toBe(1);
      }
    });

    it('an empty impactBand/type array is unconstrained, same as omitted', () => {
      const full = buildEvidenceReport(fixtureWithVariety()).json;
      const { json } = buildEvidenceReport(fixtureWithVariety(), { findingsFilter: { impactBand: [], type: [] } });
      expect(json.findings).toEqual(full.findings);
    });

    it('renders the filtered count in Markdown\'s Findings section while recommendations/cleanChecks headers stay full', () => {
      const full = buildEvidenceReport(fixtureWithVariety());
      const { markdown, json } = buildEvidenceReport(fixtureWithVariety(), { findingsFilter: { type: ['skew'] } });
      expect(markdown).toContain('## Findings (1)');
      expect(markdown).toContain(`## Fix these first (${full.json.recommendations.length})`);
      expect(markdown).toContain(`## Clean checks (${full.json.cleanChecks.length})`);
      expect(json.findings).toHaveLength(1);
    });

    it('produces no matches (empty findings array) rather than throwing when nothing matches', () => {
      const { json } = buildEvidenceReport(fixtureWithVariety(), { findingsFilter: { type: ['not-a-real-type'] } });
      expect(json.findings).toEqual([]);
    });
  });
});
