import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpServer } from '../src/mcp-server-factory.js';
import { paginateDiagnose, DEFAULT_PAGE_CHARS } from '../src/diagnose-pagination.ts';
import { resolveOrCreateRun, diagnoseRun } from '../src/mcp-tools.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const dirs = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// One slow task among nine fast ones in each stage: one straggler finding and one metrics row per stage.
function tmpLargeEventLog(stageCount) {
  const dir = mkdtempSync(join(tmpdir(), 'sparkforensics-pagination-'));
  dirs.push(dir);
  const path = join(dir, 'eventlog');
  const lines = ['{"Event":"SparkListenerApplicationStart","App ID":"app-large","App Name":"t","Timestamp":0}'];
  for (let stage = 1; stage <= stageCount; stage++) {
    lines.push(`{"Event":"SparkListenerStageSubmitted","Stage Info":{"Stage ID":${stage},"Stage Name":"stage ${stage} with a descriptive name","Number of Tasks":10}}`);
    for (let task = 0; task < 10; task++) {
      const runTime = task === 9 ? 2000 : 100;
      lines.push(JSON.stringify({
        Event: 'SparkListenerTaskEnd', 'Stage ID': stage,
        'Task Info': { 'Task ID': stage * 100 + task, 'Launch Time': 0, 'Finish Time': runTime, Failed: false, Killed: false, Speculative: false },
        'Task Metrics': { 'Executor Run Time': runTime, 'JVM GC Time': 0, 'Memory Bytes Spilled': 0, 'Disk Bytes Spilled': 0 },
      }));
    }
    lines.push(`{"Event":"SparkListenerStageCompleted","Stage Info":{"Stage ID":${stage},"Stage Name":"stage ${stage} with a descriptive name","Number of Tasks":10,"Completion Time":2000}}`);
  }
  lines.push('{"Event":"SparkListenerApplicationEnd","Timestamp":2000}');
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

async function connectedClient() {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

const diagnose = (client, args) => client.callTool({ name: 'diagnose_run', arguments: args });

async function allPages(client, args) {
  const pages = [];
  let cursor;
  do {
    const result = await diagnose(client, { ...args, ...(cursor ? { cursor } : {}) });
    expect(result.isError).toBeFalsy();
    pages.push(result);
    cursor = result.structuredContent.pagination?.nextCursor ?? undefined;
  } while (cursor);
  return pages;
}

// The unpaged answer the handler would page, as a client would parse it.
async function wholeDiagnosis(path, args = {}) {
  const { runId } = await resolveOrCreateRun({ source: { path } });
  return JSON.parse(JSON.stringify(diagnoseRun(runId, { view: 'compact', ...args })));
}

function pagesOf(result, pageChars) {
  const pages = [];
  let cursor;
  do {
    const page = paginateDiagnose(result, { cursor, pageChars });
    pages.push(JSON.parse(JSON.stringify(page)));
    cursor = page.pagination?.nextCursor ?? undefined;
  } while (cursor);
  return pages;
}

describe('diagnose_run pagination', () => {
  const path = tmpLargeEventLog(150);

  it('returns a run that fits the budget unchanged, with no pagination field', async () => {
    const client = await connectedClient();
    const small = await diagnose(client, { source: { path }, maxFindings: 1, type: ['straggler'] });
    expect(small.structuredContent.pagination).toBeUndefined();
    expect(small.content[0].text).toBe(JSON.stringify(small.structuredContent));
  });

  it('keeps every compact page of a large run under the default budget and loses no row', async () => {
    const client = await connectedClient();
    const whole = await wholeDiagnosis(path);
    expect(whole.findings.length).toBeGreaterThan(100);
    expect(JSON.stringify(whole).length).toBeGreaterThan(DEFAULT_PAGE_CHARS);

    const pages = await allPages(client, { source: { path } });
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page.content[0].text.length).toBeLessThanOrEqual(DEFAULT_PAGE_CHARS);

    const [first, ...rest] = pages.map((page) => page.structuredContent);
    expect(first.pagination).toMatchObject({ page: 1, totals: { findings: whole.findings.length } });
    expect(first.verdict).toEqual(whole.verdict);
    expect(first.recommendations).toEqual(whole.recommendations);
    expect(first.effectiveConf).toEqual(whole.effectiveConf);
    expect(first.metrics.time).toEqual(whole.metrics.time);
    expect(rest.map((page) => page.pagination.page)).toEqual(rest.map((_, i) => i + 2));
    expect(pages.at(-1).structuredContent.pagination.nextCursor).toBeNull();

    const findings = [first, ...rest].flatMap((page) => page.findings ?? []);
    expect(findings).toEqual(whole.findings);
    const stages = Object.assign({}, ...[first, ...rest].map((page) => page.metrics?.stages ?? {}));
    expect(stages).toEqual(whole.metrics.stages);
  });

  it('pages the full view too, with its clean and not-run check lists', async () => {
    const client = await connectedClient();
    const whole = await wholeDiagnosis(path, { view: 'full' });
    const pages = await allPages(client, { source: { path }, view: 'full' });
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page.content[0].text.length).toBeLessThanOrEqual(DEFAULT_PAGE_CHARS);
    const structured = pages.map((page) => page.structuredContent);
    expect(structured.flatMap((page) => page.findings ?? [])).toEqual(whole.findings);
    expect(structured.flatMap((page) => page.cleanChecks ?? [])).toEqual(whole.cleanChecks);
    expect(structured.flatMap((page) => page.notRunChecks ?? [])).toEqual(whole.notRunChecks);
  });

  it('serves the same pages for a repeated call', async () => {
    const client = await connectedClient();
    const first = await diagnose(client, { source: { path } });
    const again = await diagnose(client, { source: { path } });
    expect(again.structuredContent.pagination.nextCursor).toBe(first.structuredContent.pagination.nextCursor);
    expect((await diagnose(client, { runId: first.structuredContent.runId, cursor: first.structuredContent.pagination.nextCursor })).structuredContent.pagination.page).toBe(2);
  });

  it('refuses a cursor from another run or other filters', async () => {
    const client = await connectedClient();
    const first = await diagnose(client, { source: { path } });
    const { nextCursor } = first.structuredContent.pagination;
    const filtered = await diagnose(client, { source: { path }, type: ['straggler'], maxFindings: 3, cursor: nextCursor });
    expect(filtered.isError).toBe(true);
    expect(filtered.structuredContent.code).toBe('invalid-cursor');
    const garbage = await diagnose(client, { source: { path }, cursor: 'not-a-cursor' });
    expect(garbage.structuredContent.code).toBe('invalid-cursor');
  });

  it('always puts a row on a later page, even when the budget is smaller than the row', async () => {
    const whole = await wholeDiagnosis(path, { type: ['straggler'] });
    const pages = pagesOf(whole, 2000);
    expect(pages.length).toBeGreaterThan(5);
    expect(pages.flatMap((page) => page.findings ?? [])).toEqual(whole.findings);
  });

  it('does not page the Markdown report', async () => {
    const client = await connectedClient();
    const md = await diagnose(client, { source: { path }, format: 'md' });
    expect(md.content[0].text).toMatch(/^# Spark run evidence report/);
    expect(md.structuredContent.pagination).toBeUndefined();
  });

  it('refuses a cursor cut from other rows of the same count', () => {
    const row = (id) => ({ id, type: 'straggler', padding: 'x'.repeat(100) });
    const result = (ids) => ({ runId: 'r', view: 'compact', runComplete: true, findings: ids.map(row), metrics: { stages: {} }, writeTargets: { writes: [] } });
    const { nextCursor } = paginateDiagnose(result(['a', 'b', 'c', 'd']), { pageChars: 500 }).pagination;
    expect(nextCursor).toBeTruthy();
    expect(() => paginateDiagnose(result(['a', 'b', 'c', 'e']), { pageChars: 500, cursor: nextCursor })).toThrow(/cursor/);
    expect(paginateDiagnose(result(['a', 'b', 'c', 'd']), { pageChars: 500, cursor: nextCursor }).pagination.page).toBe(2);
  });

  it('paginateDiagnose leaves the result alone when it fits and no cursor is given', () => {
    const result = { runId: 'r', view: 'compact', findings: [], runComplete: true, metrics: { stages: {} }, writeTargets: { writes: [] } };
    expect(paginateDiagnose(result)).toBe(result);
  });
});

describe('diagnose_run format "md"', () => {
  const path = tmpLargeEventLog(3);

  // A client that reads only structuredContent must get the same report as content[0].text.
  it.each([
    [{ view: 'full', type: ['straggler'] }],
    [{ view: 'compact' }],
    [{}],
  ])('puts the report in content[0].text for %j', async (args) => {
    const client = await connectedClient();
    const result = await diagnose(client, { source: { path }, format: 'md', ...args });
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toMatch(/^# Spark run evidence report/);
    expect(Object.keys(result.structuredContent).sort()).toEqual(
      ['findingCount', 'findingsOmitted', 'markdown', 'notesHidden', 'recommendationCount', 'runComplete', 'runId', 'title']);
    expect(result.structuredContent.markdown).toBe(result.content[0].text);
  });
});

describe('get_finding_evidence by appId', () => {
  const path = tmpLargeEventLog(3);
  const evidence = (client, args) => client.callTool({ name: 'get_finding_evidence', arguments: args });

  it('analyses the source again when the runId is not cached, and finds the same finding', async () => {
    const client = await connectedClient();
    const diagnosis = (await diagnose(client, { source: { path } })).structuredContent;
    const finding = diagnosis.findings.find((row) => row.type === 'straggler');
    const viaRunId = (await evidence(client, { runId: diagnosis.runId, findingId: finding.id })).structuredContent;

    const restarted = await evidence(client, { runId: 'a-runid-from-before-the-restart', source: { path }, appId: 'app-large', findingId: finding.id });
    expect(restarted.isError).toBeFalsy();
    expect(restarted.structuredContent.finding).toEqual(viaRunId.finding);

    const bySource = await evidence(client, { source: { path }, appId: 'app-large', findingId: finding.id });
    expect(bySource.structuredContent.finding).toEqual(viaRunId.finding);
  });

  it('prefers a cached runId over the source', async () => {
    const client = await connectedClient();
    const diagnosis = (await diagnose(client, { source: { path } })).structuredContent;
    const finding = diagnosis.findings[0];
    const result = await evidence(client, { runId: diagnosis.runId, source: { path: '/no/such/file' }, findingId: finding.id });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.runId).toBe(diagnosis.runId);
  });

  it('refuses a source that holds another application', async () => {
    const client = await connectedClient();
    const result = await evidence(client, { source: { path }, appId: 'application_0000000000000_0002', findingId: 'whatever' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe('run-not-found');
    expect(result.content[0].text).not.toContain(path);
  });

  it('matches the redacted app id under redact and does not print the real one', async () => {
    const client = await connectedClient();
    const diagnosis = (await diagnose(client, { source: { path }, redact: true })).structuredContent;
    const finding = diagnosis.findings.find((row) => row.type === 'straggler');
    expect(diagnosis.app.id).toMatch(/^app-\d+$/);
    const result = await evidence(client, { source: { path }, appId: diagnosis.app.id, redact: true, findingId: finding.id });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.finding.id).toBe(finding.id);
    const wrong = await evidence(client, { source: { path }, appId: 'application_0000000000000_0002', redact: true, findingId: finding.id });
    expect(wrong.structuredContent.code).toBe('run-not-found');
    expect(wrong.content[0].text).not.toContain('app-large');
  });

  it.each([
    [{ appId: 'app-large', findingId: 'x' }, 'appId needs the source'],
    [{ findingId: 'x' }, 'Provide runId, or source'],
  ])('refuses %j without something to analyse', async (args, message) => {
    const client = await connectedClient();
    const result = await evidence(client, args);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(message);
  });

  it('keeps run-not-found for an unknown runId with no source', async () => {
    const client = await connectedClient();
    const result = await evidence(client, { runId: 'gone', findingId: 'x' });
    expect(result.structuredContent.code).toBe('run-not-found');
  });
});
