import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRun } from '../src/cli/collect-run.js';
import { captureSnapshot } from '../src/session-snapshot.js';
import { alignStages, comparisonDetailNormalizer, comparisonIdentity, isDeltaBookkeepingStage } from '../src/stage-alignment.js';
import { compareRuns, stageIdentity } from '../src/run-comparison.js';

// The matcher on the public corpus (dev/log-corpus submodule; the suite skips without it): a run
// paired with itself, swapping the roles, repeating the call, the over-merge check, and a
// committed expected-coverage snapshot for the pairwise-* logs. The snapshot changes only on
// purpose: rerun with UPDATE_ALIGNMENT_SNAPSHOT=1 and commit the diff.
const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, '..', '..', '..', 'dev', 'log-corpus', 'logs');
const SNAPSHOT = join(HERE, 'fixtures', 'stage-alignment-coverage.json');

const listed = (dir, prefix = '') => (existsSync(dir)
  ? readdirSync(dir).filter((f) => f.endsWith('.ndjson')).sort().map((f) => ({ name: `${prefix}${f}`, path: join(dir, f) }))
  : []);
const LOGS = [...listed(CORPUS), ...listed(join(CORPUS, 'external'), 'external/')];

const snapshots = new Map();
beforeAll(async () => {
  for (const { name, path } of LOGS) {
    const { appModel } = await collectRun(path);
    snapshots.set(name, captureSnapshot(appModel, [], new Map()));
  }
}, 120_000);

const pairsOf = (alignment) => alignment.pairs.map((p) => [p.baseStageIds[0], p.candStageIds[0]]);
const round = (x) => (x == null ? null : Math.round(x * 10_000) / 10_000);

describe.skipIf(LOGS.length === 0)('stage aligner on the public corpus', () => {
  it('pairs every log with itself: each stage with itself, only exact pairs, full runtime coverage', () => {
    for (const [name, snap] of snapshots) {
      const result = alignStages(snap, snap);
      expect(result.pairs.every((p) => p.quality === 'exact' && p.score === 1), name).toBe(true);
      expect(pairsOf(result).every(([b, c]) => b === c), name).toBe(true);
      expect(result.unmatched, name).toEqual({ baseStageIds: [], candStageIds: [] });
      const bookkeeping = result.bookkeepingStageIds.baseStageIds.length;
      expect(result.pairs.length + bookkeeping, name).toBe(snap.stages.size);
      // null only when the log recorded no executor run time at all.
      const total = [...snap.stages.values()].reduce((sum, s) => sum + (s.executorRunTime ?? 0), 0);
      if (total > 0) expect(result.runtimeCoverage, name).toBe(1);
    }
  });

  it('mirrors the pairs when baseline and candidate swap, and repeats exactly', () => {
    const names = [...snapshots.keys()];
    for (let i = 0; i < names.length; i += 1) {
      for (const j of [i + 1, i + 7]) {
        if (j >= names.length) continue;
        const a = snapshots.get(names[i]), b = snapshots.get(names[j]);
        const forward = alignStages(a, b), backward = alignStages(b, a);
        expect(pairsOf(backward).map(([x, y]) => [y, x]).sort((p, q) => p[0] - q[0] || p[1] - q[1])).toEqual(pairsOf(forward));
        expect(backward.unmatched).toEqual({ baseStageIds: forward.unmatched.candStageIds, candStageIds: forward.unmatched.baseStageIds });
        expect(backward.runtimeCoverage).toBe(forward.runtimeCoverage);
        // Replanned groups mirror too: the sides swap, the executions and the totals swap with them.
        expect(backward.replanned).toEqual(forward.replanned.map((g) => ({
          baseExecutionId: g.candExecutionId, candExecutionId: g.baseExecutionId,
          baseStageIds: g.candStageIds, candStageIds: g.baseStageIds,
          deltas: Object.fromEntries(Object.entries(g.deltas).map(([k, d]) => [k, {
            baseline: d.candidate, candidate: d.baseline, delta: d.delta == null ? null : 0 - d.delta,
          }])),
        })));
        expect(JSON.stringify(alignStages(a, b))).toBe(JSON.stringify(forward));
      }
    }
  });

  // Checkpoint 1's over-merge check: the comparison key may not fuse stages the exact key keeps
  // apart, except stages the Delta bookkeeping flag removes from the comparison.
  it('keeps at least as many distinct keys per run as the exact stageIdentity, bookkeeping stages aside', () => {
    const normalizer = comparisonDetailNormalizer();
    for (const [name, snap] of snapshots) {
      const kept = [...snap.stages.values()].filter((s) => !isDeltaBookkeepingStage(s, snap.sql));
      const exact = new Set(kept.map((s) => stageIdentity(s, snap)));
      const comparison = new Set(kept.map((s) => comparisonIdentity(s, snap, normalizer)));
      expect(comparison.size, name).toBeGreaterThanOrEqual(exact.size);
    }
  });

  // Checkpoints 2 and 3's over-merge check, with the replanned fallback on. The structural key is
  // coarser than the exact one by design, so a distinct-key count proves nothing here. Instead a
  // run paired with itself pairs every stage with itself (above), and runs of different jobs pair
  // nothing, which keeps them out of `ok`. The generated workload logs and the failure and external
  // logs come from different jobs; a log of a single generic stage (a lone `count`) is left out,
  // since it is the same stage in any job.
  describe('negative control: runs of different jobs', () => {
    const generated = ['pairwise-01.ndjson', 'pairwise-04.ndjson', 'cache-memory-only.ndjson', 'spark-3.5-parquet-baseline.ndjson'];
    const others = [...snapshots.keys()].filter((n) => /^(failure-|external\/)/.test(n));

    it('gets no pair, so none is exact, and cannot reach ok', () => {
      for (const g of generated) for (const o of others) {
        const [a, b] = [snapshots.get(g), snapshots.get(o)];
        if (!a || !b) continue;
        const result = compareRuns({ label: 'b', snapshot: a }, { label: 'c', snapshot: b });
        expect(result.stagePairs.filter((p) => p.quality === 'exact'), `${g} vs ${o}`).toEqual([]);
        expect(result.confidence, `${g} vs ${o}`).not.toBe('ok');
      }
    });

    it('counts replanned run time toward coverage only where executions agree', () => {
      for (const g of generated) for (const o of others) {
        const [a, b] = [snapshots.get(g), snapshots.get(o)];
        if (!a || !b) continue;
        const result = alignStages(a, b);
        expect(result.replanned, `${g} vs ${o}`).toEqual([]);
      }
    });
  });

  describe('pairwise-* expected coverage', () => {
    const pairwise = LOGS.filter((l) => /^pairwise-\d+\.ndjson$/.test(l.name)).map((l) => l.name);
    const compute = () => {
      const rows = {};
      for (let i = 0; i < pairwise.length; i += 1) {
        for (let j = i; j < pairwise.length; j += 1) {
          const result = compareRuns(
            { label: 'baseline', snapshot: snapshots.get(pairwise[i]) },
            { label: 'candidate', snapshot: snapshots.get(pairwise[j]) },
          );
          rows[`${pairwise[i]} -> ${pairwise[j]}`] = {
            pairs: result.stagePairs.length,
            unmatched: [result.unmatched.baseStageIds.length, result.unmatched.candStageIds.length],
            matchedCoverage: round(result.matchedCoverage),
            runtimeCoverage: round(result.runtimeCoverage),
            confidence: result.confidence,
          };
        }
      }
      return rows;
    };

    it('matches the committed snapshot', () => {
      const actual = compute();
      if (process.env.UPDATE_ALIGNMENT_SNAPSHOT) {
        writeFileSync(SNAPSHOT, `${JSON.stringify(actual, null, 2)}\n`);
        return;
      }
      expect(actual).toEqual(JSON.parse(readFileSync(SNAPSHOT, 'utf8')));
    });
  });
});
