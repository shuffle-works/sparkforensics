import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// packages/analyze and packages/sparkforensics only exist to claim their npm
// names: each runs sparkforensics-cli's bin unchanged. In the workspace,
// node_modules/sparkforensics-cli links to packages/cli, so this spawns the
// real CLI through each alias and checks the two agree.
const CLI_BIN = 'packages/cli/bin/sparkforensics-analyze.mjs';
const ALIASES = {
  'sparkforensics-analyze': 'packages/analyze',
  sparkforensics: 'packages/sparkforensics',
};

let logDir;

function eventLog({ complete }) {
  const lines = [
    '{"Event":"SparkListenerApplicationStart","App ID":"application_0000000000000_0001","App Name":"t","Timestamp":0}',
    '{"Event":"SparkListenerStageSubmitted","Stage Info":{"Stage ID":1,"Stage Name":"s1","Number of Tasks":2}}',
  ];
  for (let i = 0; i < 2; i++) {
    lines.push(JSON.stringify({
      Event: 'SparkListenerTaskEnd', 'Stage ID': 1,
      'Task Info': { 'Task ID': i, 'Launch Time': 0, 'Finish Time': 100, Failed: false, Killed: false, Speculative: false },
      'Task Metrics': { 'Executor Run Time': 100, 'JVM GC Time': 0, 'Memory Bytes Spilled': 0, 'Disk Bytes Spilled': 0 },
    }));
  }
  lines.push('{"Event":"SparkListenerStageCompleted","Stage Info":{"Stage ID":1,"Stage Name":"s1","Number of Tasks":2,"Completion Time":100}}');
  if (complete) lines.push('{"Event":"SparkListenerApplicationEnd","Timestamp":100}');
  return `${lines.join('\n')}\n`;
}

function run(bin, args) {
  const { stdout, stderr, status } = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
  return { stdout, stderr, status };
}

beforeAll(() => {
  logDir = mkdtempSync(join(tmpdir(), 'alias-packages-'));
  writeFileSync(join(logDir, 'complete.ndjson'), eventLog({ complete: true }));
  writeFileSync(join(logDir, 'incomplete.ndjson'), eventLog({ complete: false }));
});

afterAll(() => {
  rmSync(logDir, { recursive: true, force: true });
});

describe('alias packages', () => {
  it('ship the same bin file', () => {
    const [first, ...rest] = Object.values(ALIASES).map((dir) => readFileSync(join(dir, 'bin/sparkforensics-analyze.mjs'), 'utf8'));
    for (const other of rest) expect(other).toBe(first);
  });

  it('depend on sparkforensics-cli at their own version and expose only sparkforensics-analyze', () => {
    for (const [name, dir] of Object.entries(ALIASES)) {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      expect(manifest.name).toBe(name);
      expect(manifest.dependencies).toEqual({ 'sparkforensics-cli': `^${manifest.version}` });
      expect(manifest.bin).toEqual({ 'sparkforensics-analyze': 'bin/sparkforensics-analyze.mjs' });
    }
  });

  // One case per CLI exit code: 0 clean, 1 budget violated, 2 bad input, 3 inconclusive.
  const cases = [
    { status: 0, args: () => ['--help'] },
    { status: 0, args: () => [join(logDir, 'complete.ndjson'), '--format', 'md'] },
    { status: 1, args: () => [join(logDir, 'complete.ndjson'), '--format', 'md', '--max-runtime', '1'] },
    { status: 2, args: () => [join(logDir, 'missing.ndjson')] },
    { status: 3, args: () => [join(logDir, 'incomplete.ndjson'), '--format', 'md'] },
  ];

  for (const [name, dir] of Object.entries(ALIASES)) {
    it.each(cases)(`${name} passes through exit code $status and output`, ({ status, args }) => {
      const direct = run(CLI_BIN, args());
      const viaAlias = run(join(dir, 'bin/sparkforensics-analyze.mjs'), args());
      expect(direct.status).toBe(status);
      expect(viaAlias).toEqual(direct);
    });
  }
});
