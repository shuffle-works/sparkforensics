import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveOrCreateRun, diagnoseRun, getFindingEvidence, getFindingDocumentation, getReferenceDoc, getRunSummary, compareRuns, evaluateBudgetsForRun,
} from '../src/mcp-tools.js';
import * as collectRunModule from '../src/cli/collect-run.js';
import { buildEvidenceReport } from '../src/evidence-report.js';
// Helper lives at repo-root tests/helpers/: shared with tests/cli-sparkforensics-analyze.test.js.
import { shsZipFetch } from '../../../tests/helpers/shs-fixtures.js';

function tmpEventLog() {
  const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-mcp-'));
  const path = join(dir, 'eventlog');
  writeFileSync(path,
    '{"Event":"SparkListenerApplicationStart","App ID":"app-1","App Name":"t","Timestamp":0}\n'
    + '{"Event":"SparkListenerApplicationEnd","Timestamp":100}\n');
  return { dir, path };
}

// Produces exactly 2 findings (memoryUtilization info/no-stage, straggler info/stage 1): one slow task among 9 fast ones.
function tmpEventLogWithFindings() {
  const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-mcp-'));
  const path = join(dir, 'eventlog');
  const lines = [
    '{"Event":"SparkListenerApplicationStart","App ID":"app-findings","App Name":"t","Timestamp":0}',
    '{"Event":"SparkListenerStageSubmitted","Stage Info":{"Stage ID":1,"Stage Name":"s1","Number of Tasks":10}}',
  ];
  for (let i = 0; i < 9; i++) {
    lines.push(JSON.stringify({
      Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
      'Task Info': { 'Task ID': i, 'Launch Time': 0, 'Finish Time': 100, Failed: false, Killed: false, Speculative: false },
      'Task Metrics': { 'Executor Run Time': 100, 'JVM GC Time': 0, 'Memory Bytes Spilled': 0, 'Disk Bytes Spilled': 0 },
    }));
  }
  lines.push(JSON.stringify({
    Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
    'Task Info': { 'Task ID': 9, 'Launch Time': 0, 'Finish Time': 2000, Failed: false, Killed: false, Speculative: false },
    'Task Metrics': { 'Executor Run Time': 2000, 'JVM GC Time': 0, 'Memory Bytes Spilled': 0, 'Disk Bytes Spilled': 0 },
  }));
  lines.push('{"Event":"SparkListenerStageCompleted","Stage Info":{"Stage ID":1,"Stage Name":"s1","Number of Tasks":10,"Completion Time":2000}}');
  lines.push('{"Event":"SparkListenerApplicationEnd","Timestamp":2000}');
  writeFileSync(path, `${lines.join('\n')}\n`);
  return { dir, path };
}

describe('resolveOrCreateRun (path source)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('parses a path source and mints a runId', async () => {
    const { dir, path } = tmpEventLog();
    try {
      const { runId, appModel } = await resolveOrCreateRun({ source: { path } });
      expect(typeof runId).toBe('string');
      expect(appModel.app.id).toBe('app-1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reuses the cached runId on a second call with the same path (no re-parse)', async () => {
    const { dir, path } = tmpEventLog();
    const spy = vi.spyOn(collectRunModule, 'collectRun');
    try {
      const first = await resolveOrCreateRun({ source: { path } });
      const second = await resolveOrCreateRun({ source: { path } });
      expect(second.runId).toBe(first.runId);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dedupes concurrent resolutions for the same uncached source (no duplicate parse)', async () => {
    const { dir, path } = tmpEventLog();
    const spy = vi.spyOn(collectRunModule, 'collectRun');
    try {
      const [first, second] = await Promise.all([
        resolveOrCreateRun({ source: { path } }),
        resolveOrCreateRun({ source: { path } }),
      ]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(second.runId).toBe(first.runId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('looks up an existing runId directly, bypassing source resolution', async () => {
    const { dir, path } = tmpEventLog();
    try {
      const { runId } = await resolveOrCreateRun({ source: { path } });
      const byId = await resolveOrCreateRun({ runId });
      expect(byId.appModel.app.id).toBe('app-1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws run-not-found for an unknown runId', async () => {
    await expect(resolveOrCreateRun({ runId: 'nonexistent' }))
      .rejects.toMatchObject({ code: 'run-not-found' });
  });

  it('throws invalid-event-log for a nonexistent path, not a raw ENOENT', async () => {
    await expect(resolveOrCreateRun({ source: { path: '/definitely/does/not/exist' } }))
      .rejects.toMatchObject({ code: 'invalid-event-log' });
  });
});

describe('resolveOrCreateRun (SHS source)', () => {
  it('fetches, unzips, and decodes an SHS archive', async () => {
    const ndjson = '{"Event":"SparkListenerApplicationStart","App ID":"app-shs","App Name":"t","Timestamp":0}\n'
      + '{"Event":"SparkListenerApplicationEnd","Timestamp":100}\n';
    const fetchImpl = shsZipFetch(ndjson);
    const { runId, appModel } = await resolveOrCreateRun(
      { source: { shsBaseUrl: 'http://shs:18080', appId: 'application_1_1' } },
      { fetchImpl },
    );
    expect(typeof runId).toBe('string');
    expect(appModel.app.id).toBe('app-shs');
  });

  it('surfaces upstream-unreachable on a connection failure', async () => {
    const fetchImpl = async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); };
    await expect(resolveOrCreateRun(
      // Distinct appId from sibling tests: same shsCacheKey would serve the cached appModel instead of re-fetching.
      { source: { shsBaseUrl: 'http://shs:18080', appId: 'application_1_2' } },
      { fetchImpl },
    )).rejects.toMatchObject({ code: 'upstream-unreachable' });
  });

  it('rejects an SHS archive whose declared content-length exceeds the cap', async () => {
    const fetchImpl = async () => ({
      ok: true, status: 200,
      headers: { get: (n) => (n.toLowerCase() === 'content-length' ? String(10 * 1024) : null) },
      body: new ReadableStream({ start(c) { c.close(); } }),
    });
    await expect(resolveOrCreateRun(
      { source: { shsBaseUrl: 'http://shs:18080', appId: 'application_1_4' } },
      { fetchImpl, maxArchiveBytes: 1024 },
    )).rejects.toMatchObject({ code: 'archive-too-large' });
  });

  it('rejects a streamed SHS archive that exceeds the cap without a content-length', async () => {
    const fetchImpl = async () => ({
      ok: true, status: 200,
      headers: { get: () => null },
      body: new ReadableStream({
        start(c) { c.enqueue(new Uint8Array(2048)); c.close(); },
      }),
    });
    await expect(resolveOrCreateRun(
      { source: { shsBaseUrl: 'http://shs:18080', appId: 'application_1_5' } },
      { fetchImpl, maxArchiveBytes: 1024 },
    )).rejects.toMatchObject({ code: 'archive-too-large' });
  });

  it('rejects with upstream-unreachable when the archive body stalls past the idle timeout', async () => {
    const fetchImpl = async () => ({
      ok: true, status: 200,
      headers: { get: () => null },
      // Emits one chunk then stalls forever: headers arrived, body went idle.
      body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(16)); } }),
    });
    await expect(resolveOrCreateRun(
      { source: { shsBaseUrl: 'http://shs:18080', appId: 'application_1_6' } },
      { fetchImpl, idleTimeoutMs: 20 },
    )).rejects.toMatchObject({ code: 'upstream-unreachable' });
  });

  it('surfaces invalid-event-log on a corrupt archive', async () => {
    const fetchImpl = async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    await expect(resolveOrCreateRun(
      { source: { shsBaseUrl: 'http://shs:18080', appId: 'application_1_3' } },
      { fetchImpl },
    )).rejects.toMatchObject({ code: 'invalid-event-log' });
  });
});

describe('resolveOrCreateRun (cache eviction)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('evicts the oldest entry once the 9th distinct source is resolved (cap: 8)', async () => {
    const fixtures = Array.from({ length: 9 }, () => tmpEventLog());
    const spy = vi.spyOn(collectRunModule, 'collectRun');
    try {
      const runIds = [];
      for (const { path } of fixtures) {
        runIds.push((await resolveOrCreateRun({ source: { path } })).runId);
      }
      expect(spy).toHaveBeenCalledTimes(9);
      // The 1st source was never re-touched, so it's the oldest -> evicted by the 9th insert.
      const reResolved = await resolveOrCreateRun({ source: { path: fixtures[0].path } });
      expect(spy).toHaveBeenCalledTimes(10); // re-parsed, not served from cache
      expect(reResolved.runId).not.toBe(runIds[0]); // a fresh runId was minted
    } finally {
      for (const { dir } of fixtures) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('evicts an entry once it has been idle past the 15-minute TTL', async () => {
    const { dir, path } = tmpEventLog();
    const spy = vi.spyOn(collectRunModule, 'collectRun');
    vi.useFakeTimers();
    try {
      const first = await resolveOrCreateRun({ source: { path } });
      vi.advanceTimersByTime(16 * 60 * 1000);
      const second = await resolveOrCreateRun({ source: { path } });
      expect(spy).toHaveBeenCalledTimes(2); // re-parsed after TTL expiry, not served from cache
      expect(second.runId).not.toBe(first.runId);
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('diagnoseRun / getFindingEvidence', () => {
  it('returns the same findings buildEvidenceReport would produce for the same appModel', async () => {
    const { dir, path } = tmpEventLog();
    try {
      const { runId } = await resolveOrCreateRun({ source: { path } });
      const { findings } = diagnoseRun(runId);
      expect(Array.isArray(findings)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('also surfaces the recommendations rollup and cleanChecks list from buildEvidenceReport', async () => {
    const { dir, path } = tmpEventLog();
    try {
      const { runId } = await resolveOrCreateRun({ source: { path } });
      const { recommendations, cleanChecks } = diagnoseRun(runId);
      expect(Array.isArray(recommendations)).toBe(true);
      expect(Array.isArray(cleanChecks)).toBe(true);
      expect(cleanChecks.length).toBeGreaterThan(0);
      for (const c of cleanChecks) {
        expect(typeof c.type).toBe('string');
        expect(typeof c.tag).toBe('string');
        expect(typeof c.thresholdSummary).toBe('string');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws run-not-found for an unknown runId', () => {
    expect(() => diagnoseRun('nonexistent')).toThrow(expect.objectContaining({ code: 'run-not-found' }));
  });

  it('reports runComplete false and surfaces an incompleteRun finding for a truncated run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-mcp-'));
    const path = join(dir, 'eventlog');
    writeFileSync(path, '{"Event":"SparkListenerApplicationStart","App ID":"app-3","App Name":"t","Timestamp":0}\n');
    try {
      const { runId } = await resolveOrCreateRun({ source: { path } });
      const result = diagnoseRun(runId);
      expect(result.runComplete).toBe(false);
      expect(result.findings.some((f) => f.type === 'incompleteRun')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('looks up a specific finding by id, or throws finding-not-found', async () => {
    const { dir, path } = tmpEventLog();
    try {
      const { runId } = await resolveOrCreateRun({ source: { path } });
      const { findings } = diagnoseRun(runId);
      if (findings.length > 0) {
        const { finding } = getFindingEvidence(runId, findings[0].id);
        expect(finding.id).toBe(findings[0].id);
      }
      expect(() => getFindingEvidence(runId, 'not-a-real-id'))
        .toThrow(expect.objectContaining({ code: 'finding-not-found' }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('diagnose_run and get_finding_evidence surface impactEstimate on the incompleteRun finding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-mcp-'));
    const path = join(dir, 'eventlog');
    writeFileSync(path, '{"Event":"SparkListenerApplicationStart","App ID":"app-4","App Name":"t","Timestamp":0}\n');
    try {
      const { runId } = await resolveOrCreateRun({ source: { path } });
      const { findings } = diagnoseRun(runId);
      const incomplete = findings.find((f) => f.type === 'incompleteRun');
      expect(incomplete).toBeDefined();
      expect(incomplete.impactEstimate).toEqual({ basis: 'informational', wallClock: null, estimateMethod: 'none' });

      const { finding } = getFindingEvidence(runId, incomplete.id);
      expect(finding.impactEstimate).toEqual(incomplete.impactEstimate);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('with { redact: true } threads through to buildEvidenceReport, pseudonymizing the app id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-mcp-'));
    const path = join(dir, 'eventlog');
    writeFileSync(path, '{"Event":"SparkListenerApplicationStart","App ID":"app-mcp-redact-test","App Name":"t","Timestamp":0}\n');
    try {
      const { runId, appModel } = await resolveOrCreateRun({ source: { path } });
      const directRedacted = buildEvidenceReport(appModel, { redact: true }).json;
      expect(directRedacted.summary.app.id).toBe('app-1');
      expect(directRedacted.summary.app.id).not.toBe('app-mcp-redact-test');

      const redacted = diagnoseRun(runId, { redact: true });
      expect(redacted.findings).toEqual(directRedacted.findings);
      expect(redacted.recommendations).toEqual(directRedacted.recommendations);
      expect(redacted.cleanChecks).toEqual(directRedacted.cleanChecks);

      const plain = diagnoseRun(runId);
      expect(plain.findings).toEqual(buildEvidenceReport(appModel).json.findings);
      expect(redacted.findings.length).toBeGreaterThan(0);

      const evidenceRedacted = getFindingEvidence(runId, redacted.findings[0].id, { redact: true });
      expect(evidenceRedacted.finding).toEqual(directRedacted.findings[0]);
      const evidencePlain = getFindingEvidence(runId, redacted.findings[0].id);
      expect(evidencePlain.finding).toEqual(buildEvidenceReport(appModel).json.findings[0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['omitted', undefined],
    ['an empty array', []],
  ])('omits summary/evidenceAvailability/detectors when include is %s', async (_label, include) => {
    const { dir, path } = tmpEventLog();
    try {
      const { runId } = await resolveOrCreateRun({ source: { path } });
      const result = diagnoseRun(runId, include === undefined ? undefined : { include });
      expect(Object.keys(result).sort()).toEqual(
        ['cleanChecks', 'findings', 'recommendations', 'runComplete', 'runId'].sort(),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const INCLUDE_KEYS = ['summary', 'evidenceAvailability', 'detectors'];

  it.each(INCLUDE_KEYS)('adds %s matching buildEvidenceReport\'s own json field when requested alone', async (key) => {
    const { dir, path } = tmpEventLog();
    try {
      const { runId, appModel } = await resolveOrCreateRun({ source: { path } });
      const direct = buildEvidenceReport(appModel).json;
      const result = diagnoseRun(runId, { include: [key] });
      expect(result[key]).toEqual(direct[key]);
      for (const other of INCLUDE_KEYS.filter((k) => k !== key)) {
        expect(result[other]).toBeUndefined();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits markdown when { markdown: true } is not requested', async () => {
    const { dir, path } = tmpEventLog();
    try {
      const { runId } = await resolveOrCreateRun({ source: { path } });
      const result = diagnoseRun(runId);
      expect('markdown' in result).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds markdown matching buildEvidenceReport\'s own markdown when { markdown: true }', async () => {
    const { dir, path } = tmpEventLog();
    try {
      const { runId, appModel } = await resolveOrCreateRun({ source: { path } });
      const direct = buildEvidenceReport(appModel);
      const result = diagnoseRun(runId, { markdown: true });
      expect(result.markdown).toBe(direct.markdown);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds all three fields when all three are requested', async () => {
    const { dir, path } = tmpEventLog();
    try {
      const { runId, appModel } = await resolveOrCreateRun({ source: { path } });
      const direct = buildEvidenceReport(appModel).json;
      const result = diagnoseRun(runId, { include: ['summary', 'evidenceAvailability', 'detectors'] });
      expect(result.summary).toEqual(direct.summary);
      expect(result.evidenceAvailability).toEqual(direct.evidenceAvailability);
      expect(result.detectors).toEqual(direct.detectors);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('impactBand/type/stageId findings filter', () => {
    it('narrows findings by type, leaving recommendations/cleanChecks/summary full', async () => {
      const { dir, path } = tmpEventLogWithFindings();
      try {
        const { runId } = await resolveOrCreateRun({ source: { path } });
        const full = diagnoseRun(runId);
        const filtered = diagnoseRun(runId, { type: ['straggler'] });
        expect(filtered.findings).toHaveLength(1);
        expect(filtered.findings[0].type).toBe('straggler');
        expect(filtered.recommendations).toEqual(full.recommendations);
        expect(filtered.cleanChecks).toEqual(full.cleanChecks);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('narrows findings by stageId', async () => {
      const { dir, path } = tmpEventLogWithFindings();
      try {
        const { runId } = await resolveOrCreateRun({ source: { path } });
        const { findings } = diagnoseRun(runId, { stageId: 1 });
        // The fixture's one 2000ms task gates its whole 2000ms stage: both skew and straggler fire.
        expect(findings.map((f) => f.type).sort()).toEqual(['skew', 'straggler']);
        expect(findings.every((f) => f.stageId === 1)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('narrows findings by impactBand, which can exclude every finding', async () => {
      const { dir, path } = tmpEventLogWithFindings();
      try {
        const { runId } = await resolveOrCreateRun({ source: { path } });
        const { findings } = diagnoseRun(runId, { impactBand: ['warning'] });
        expect(findings).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('combines impactBand/type/stageId as AND, matching buildEvidenceReport\'s findingsFilter directly', async () => {
      const { dir, path } = tmpEventLogWithFindings();
      try {
        const { runId, appModel } = await resolveOrCreateRun({ source: { path } });
        const direct = buildEvidenceReport(appModel, {
          findingsFilter: { impactBand: ['critical'], type: ['straggler'], stageId: 1 },
        }).json;
        const result = diagnoseRun(runId, { impactBand: ['critical'], type: ['straggler'], stageId: 1 });
        expect(result.findings).toEqual(direct.findings);
        expect(result.findings).toHaveLength(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('getFindingDocumentation', () => {
  it('returns name, detectionDoc, and tuningDoc for a type with both docs', () => {
    const doc = getFindingDocumentation('skew');
    expect(doc.type).toBe('skew');
    expect(doc.name).toBe('Task Skew');
    expect(doc.detectionDoc.tag).toBe('SKEW');
    expect(doc.detectionDoc.title).toBe('Task skew');
    expect(doc.detectionDoc.content.length).toBeGreaterThan(0);
    expect(doc.tuningDoc).not.toBeNull();
    expect(doc.tuningDoc.anchor).toBe('#bottleneck-skew');
    expect(doc.tuningDoc.content.length).toBeGreaterThan(0);
  });

  it('resolves stageShape\'s tuning doc to the skew page it is a sub-anchor of', () => {
    const doc = getFindingDocumentation('stageShape');
    expect(doc.tuningDoc).not.toBeNull();
    expect(doc.tuningDoc.anchor).toBe('#bottleneck-stage-shape');
    // Same vendored content as skew's own tuning doc (one upstream page).
    expect(doc.tuningDoc.content).toBe(getFindingDocumentation('skew').tuningDoc.content);
  });

  it('resolves speculationWaste\'s tuning doc to the straggler page its sub-anchor lives on', () => {
    const doc = getFindingDocumentation('speculationWaste');
    expect(doc.tuningDoc.anchor).toBe('#bottleneck-speculation-waste');
    expect(doc.tuningDoc.content).toBe(getFindingDocumentation('straggler').tuningDoc.content);
    expect(doc.tuningDoc.content).toContain('{#bottleneck-speculation-waste}');
  });

  it('falls back to the owning chapter for a sub-anchor hosted on a chapter page', () => {
    const doc = getFindingDocumentation('autoscalingChurn');
    expect(doc.tuningDoc).not.toBeNull();
    expect(doc.tuningDoc.anchor).toBe('#bottleneck-autoscaling-churn');
    expect(doc.tuningDoc.content).toBe(getReferenceDoc('#cluster-config').content);
    expect(doc.tuningDoc.content).toContain('{#bottleneck-autoscaling-churn}');
  });

  it('returns tuningDoc: null for a type whose docAnchorForType is ambiguous', () => {
    const doc = getFindingDocumentation('configAudit');
    expect(doc.detectionDoc.content.length).toBeGreaterThan(0);
    expect(doc.tuningDoc).toBeNull();
  });

  it('throws invalid-type for an unknown finding type', () => {
    expect(() => getFindingDocumentation('zetaSignal')).toThrow();
    try {
      getFindingDocumentation('zetaSignal');
    } catch (err) {
      expect(err.code).toBe('invalid-type');
    }
  });
});

describe('getRunSummary', () => {
  it('reports counts and duration for a complete run', async () => {
    const { dir, path } = tmpEventLog();
    try {
      const { runId } = await resolveOrCreateRun({ source: { path } });
      const summary = getRunSummary(runId);
      expect(summary.app.id).toBe('app-1');
      expect(summary.stageCount).toBe(0);
      expect(summary.durationMs).toBe(100);
      expect(summary.executorCount).toEqual({ added: 0, removed: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports durationMs null when the app interval is incomplete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-mcp-'));
    const path = join(dir, 'eventlog');
    writeFileSync(path, '{"Event":"SparkListenerApplicationStart","App ID":"app-2","App Name":"t","Timestamp":0}\n');
    try {
      const { runId } = await resolveOrCreateRun({ source: { path } });
      expect(getRunSummary(runId).durationMs).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports runComplete true for a complete run', async () => {
    const { dir, path } = tmpEventLog();
    try {
      const { runId } = await resolveOrCreateRun({ source: { path } });
      expect(getRunSummary(runId).runComplete).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports runComplete false when the app interval is incomplete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-mcp-'));
    const path = join(dir, 'eventlog');
    writeFileSync(path, '{"Event":"SparkListenerApplicationStart","App ID":"app-2","App Name":"t","Timestamp":0}\n');
    try {
      const { runId } = await resolveOrCreateRun({ source: { path } });
      expect(getRunSummary(runId).runComplete).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pseudonymizes app.id with { redact: true }, leaves it as-is otherwise', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-mcp-'));
    const path = join(dir, 'eventlog');
    writeFileSync(path, '{"Event":"SparkListenerApplicationStart","App ID":"app-summary-redact-test","App Name":"t","Timestamp":0}\n');
    try {
      const { runId } = await resolveOrCreateRun({ source: { path } });
      expect(getRunSummary(runId).app.id).toBe('app-summary-redact-test');
      expect(getRunSummary(runId, { redact: false }).app.id).toBe('app-summary-redact-test');
      expect(getRunSummary(runId, { redact: true }).app.id).toBe('app-1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pseudonymizes a host-shaped app.name with { redact: true }, leaves sparkVersion untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-mcp-'));
    const path = join(dir, 'eventlog');
    writeFileSync(path,
      '{"Event":"SparkListenerLogStart","Spark Version":"3.5.0"}\n'
      + '{"Event":"SparkListenerApplicationStart","App ID":"app-summary-name-redact-test","App Name":"ip-10-20-30-40","Timestamp":0}\n');
    try {
      const { runId } = await resolveOrCreateRun({ source: { path } });
      const plain = getRunSummary(runId);
      expect(plain.app.name).toBe('ip-10-20-30-40');

      const redacted = getRunSummary(runId, { redact: true });
      expect(redacted.app.name).not.toBe('ip-10-20-30-40');
      expect(redacted.app.name).toMatch(/^host-\d+$/);
      expect(redacted.app.sparkVersion).toBe(plain.app.sparkVersion);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// One stage, 10 tasks; the last task finishes at `stragglerFinishTime` (the
// other 9 always finish at 100ms), so a high enough value trips the straggler
// detector while a low one (matching the fast tasks) does not.
function tmpEventLogWithStage(appId, stageName, stragglerFinishTime) {
  const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-mcp-'));
  const path = join(dir, 'eventlog');
  const lines = [
    `{"Event":"SparkListenerApplicationStart","App ID":"${appId}","App Name":"t","Timestamp":0}`,
    `{"Event":"SparkListenerStageSubmitted","Stage Info":{"Stage ID":1,"Stage Name":"${stageName}","Number of Tasks":10}}`,
  ];
  for (let i = 0; i < 9; i++) {
    lines.push(JSON.stringify({
      Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
      'Task Info': { 'Task ID': i, 'Launch Time': 0, 'Finish Time': 100, Failed: false, Killed: false, Speculative: false },
      'Task Metrics': { 'Executor Run Time': 100, 'JVM GC Time': 0, 'Memory Bytes Spilled': 0, 'Disk Bytes Spilled': 0 },
    }));
  }
  lines.push(JSON.stringify({
    Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
    'Task Info': { 'Task ID': 9, 'Launch Time': 0, 'Finish Time': stragglerFinishTime, Failed: false, Killed: false, Speculative: false },
    'Task Metrics': { 'Executor Run Time': stragglerFinishTime, 'JVM GC Time': 0, 'Memory Bytes Spilled': 0, 'Disk Bytes Spilled': 0 },
  }));
  lines.push(`{"Event":"SparkListenerStageCompleted","Stage Info":{"Stage ID":1,"Stage Name":"${stageName}","Number of Tasks":10,"Completion Time":${stragglerFinishTime}}}`);
  lines.push(`{"Event":"SparkListenerApplicationEnd","Timestamp":${stragglerFinishTime}}`);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return { dir, path };
}

function tmpEventLogWithDuration(appId, endTime) {
  const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-mcp-'));
  const path = join(dir, 'eventlog');
  writeFileSync(path,
    `{"Event":"SparkListenerApplicationStart","App ID":"${appId}","App Name":"t","Timestamp":0}\n`
    + `{"Event":"SparkListenerApplicationEnd","Timestamp":${endTime}}\n`);
  return { dir, path };
}

describe('compareRuns', () => {
  it('compares two path-sourced runs by wall-clock duration', async () => {
    const a = tmpEventLogWithDuration('app-a', 2000);
    const b = tmpEventLogWithDuration('app-b', 1000);
    try {
      const result = await compareRuns({ source: { path: a.path } }, { source: { path: b.path } });
      expect(typeof result.runIdA).toBe('string');
      expect(typeof result.runIdB).toBe('string');
      expect(result.findingsDelta).toEqual({ introduced: [], resolved: [] });
      const wallClock = result.metricDeltas.find((m) => m.key === 'wallClock');
      expect(wallClock.baseline).toBe(2000);
      expect(wallClock.candidate).toBe(1000);
      expect(wallClock.direction).toBe('improvement');
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
    }
  });

  it('accepts a mix of source and runId for either side', async () => {
    const a = tmpEventLogWithDuration('app-a', 2000);
    const b = tmpEventLogWithDuration('app-b', 1000);
    try {
      const { runId: runIdB } = await resolveOrCreateRun({ source: { path: b.path } });
      const result = await compareRuns({ source: { path: a.path } }, { runId: runIdB });
      expect(result.runIdB).toBe(runIdB);
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
    }
  });

  it('with { redact: true } leaves output unchanged when no host/IP data is present', async () => {
    const a = tmpEventLogWithDuration('app-a', 2000);
    const b = tmpEventLogWithDuration('app-b', 1000);
    try {
      const plain = await compareRuns({ source: { path: a.path } }, { source: { path: b.path } });
      const redacted = await compareRuns({ source: { path: a.path } }, { source: { path: b.path } }, { redact: true });
      expect(redacted).toEqual(plain);
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
    }
  });

  it('with { redact: true } pseudonymizes host/IP tokens embedded in a delta finding\'s stage names', async () => {
    const baseline = tmpEventLogWithStage('app-a', 's1', 100);
    const candidate = tmpEventLogWithStage('app-b', 'collect at ip-10-1-2-3.ec2.internal.scala:42', 2000);
    try {
      const plain = await compareRuns({ source: { path: baseline.path } }, { source: { path: candidate.path } });
      const introduced = plain.findingsDelta.introduced.find((f) => f.stages.length > 0);
      expect(introduced.stages[0]).toContain('ip-10-1-2-3.ec2.internal');

      const redacted = await compareRuns({ source: { path: baseline.path } }, { source: { path: candidate.path } }, { redact: true });
      const redactedIntroduced = redacted.findingsDelta.introduced.find((f) => f.rule === introduced.rule);
      expect(redactedIntroduced.stages[0]).not.toContain('ip-10-1-2-3.ec2.internal');
      expect(redactedIntroduced.stages[0]).toMatch(/host-\d+/);
    } finally {
      rmSync(baseline.dir, { recursive: true, force: true });
      rmSync(candidate.dir, { recursive: true, force: true });
    }
  });

  it('omits markdown when { markdown: true } is not requested', async () => {
    const a = tmpEventLogWithDuration('app-a', 2000);
    const b = tmpEventLogWithDuration('app-b', 1000);
    try {
      const result = await compareRuns({ source: { path: a.path } }, { source: { path: b.path } });
      expect('markdown' in result).toBe(false);
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
    }
  });

  it('adds markdown matching renderComparisonMarkdown\'s output when { markdown: true }', async () => {
    const a = tmpEventLogWithDuration('app-a', 2000);
    const b = tmpEventLogWithDuration('app-b', 1000);
    try {
      const result = await compareRuns(
        { source: { path: a.path } }, { source: { path: b.path } }, { markdown: true },
      );
      expect(typeof result.markdown).toBe('string');
      expect(result.markdown).toMatch(/^\n## Comparison to baseline\n/);
      expect(result.markdown).toMatch(/- matched stage coverage:/);
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
    }
  });
});

describe('evaluateBudgetsForRun', () => {
  it('evaluates a single-run budget against a freshly resolved source', async () => {
    const { dir, path } = tmpEventLogWithDuration('app-a', 1000);
    try {
      const { runId, results, violated, inconclusive } = await evaluateBudgetsForRun(
        { source: { path } }, { maxRuntimeMs: 500 },
      );
      expect(typeof runId).toBe('string');
      expect(results).toEqual([{ name: 'max-runtime', status: 'violation', detail: 'Runtime 1000ms exceeds budget 500ms.' }]);
      expect(violated).toBe(true);
      expect(inconclusive).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes a single-run budget within range', async () => {
    const { dir, path } = tmpEventLogWithDuration('app-a', 1000);
    try {
      const { results, violated } = await evaluateBudgetsForRun({ source: { path } }, { maxRuntimeMs: 5000 });
      expect(results).toEqual([{ name: 'max-runtime', status: 'pass', detail: 'Runtime 1000ms within budget 5000ms.' }]);
      expect(violated).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reuses a cached runId instead of re-resolving a source', async () => {
    const { dir, path } = tmpEventLogWithDuration('app-a', 1000);
    try {
      const { runId } = await resolveOrCreateRun({ source: { path } });
      const result = await evaluateBudgetsForRun({ runId }, { maxRuntimeMs: 5000 });
      expect(result.runId).toBe(runId);
      expect(result.violated).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves a second run and evaluates a regression budget against it', async () => {
    const a = tmpEventLogWithDuration('app-a', 1000);
    const b = tmpEventLogWithDuration('app-b', 2000);
    try {
      const { runId, results, violated } = await evaluateBudgetsForRun(
        { source: { path: a.path } }, { maxRegressionPct: 10 }, { source: { path: b.path } },
      );
      expect(typeof runId).toBe('string');
      expect(results).toEqual([{
        name: 'max-regression', status: 'violation',
        detail: 'Metric "wallClock" regressed 100.0%, exceeding budget 10%.',
      }]);
      expect(violated).toBe(true);
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
    }
  });

  it('passes a fail-on-introduced budget when the candidate introduces no matching findings', async () => {
    const a = tmpEventLogWithDuration('app-a', 1000);
    const b = tmpEventLogWithDuration('app-b', 1000);
    try {
      const { results, violated } = await evaluateBudgetsForRun(
        { source: { path: a.path } }, { failOnIntroduced: 'all' }, { source: { path: b.path } },
      );
      expect(results).toEqual([{ name: 'fail-on-introduced', status: 'pass', detail: 'No introduced findings match "all".' }]);
      expect(violated).toBe(false);
    } finally {
      rmSync(a.dir, { recursive: true, force: true });
      rmSync(b.dir, { recursive: true, force: true });
    }
  });

  it('reports max-regression as inconclusive with no second run resolved', async () => {
    const { dir, path } = tmpEventLogWithDuration('app-a', 1000);
    try {
      const { results, inconclusive, violated } = await evaluateBudgetsForRun({ source: { path } }, { maxRegressionPct: 10 });
      expect(results).toEqual([{
        name: 'max-regression', status: 'inconclusive', detail: 'No baseline comparison available to evaluate this budget.',
      }]);
      expect(inconclusive).toBe(true);
      expect(violated).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws run-not-found for an unknown runId', async () => {
    await expect(evaluateBudgetsForRun({ runId: 'nonexistent' }, { maxRuntimeMs: 5000 }))
      .rejects.toMatchObject({ code: 'run-not-found' });
  });

  it('rejects regressionMetric set without maxRegressionPct instead of silently skipping the check', async () => {
    const { dir, path } = tmpEventLogWithDuration('app-a', 1000);
    try {
      await expect(evaluateBudgetsForRun({ source: { path } }, { regressionMetric: 'shuffleSpill' }))
        .rejects.toMatchObject({ code: 'access-or-upstream-failure', message: 'regressionMetric requires maxRegressionPct.' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws run-not-found for an unknown runIdB', async () => {
    const { dir, path } = tmpEventLogWithDuration('app-a', 1000);
    try {
      await expect(evaluateBudgetsForRun({ source: { path } }, { maxRegressionPct: 10 }, { runId: 'nonexistent' }))
        .rejects.toMatchObject({ code: 'run-not-found' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
