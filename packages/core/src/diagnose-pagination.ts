import { fnv1a } from './analyzer.ts';
import { mcpError } from './mcp-error.ts';
import type { DiagnoseRunResult } from './mcp-tools.ts';

/** The character budget of one `diagnose_run` page when the caller sets none. */
export const DEFAULT_PAGE_CHARS = 50_000;

// The lists a page is cut from, in the order they are served: the rows the client reads first
// come first. Each is a list or keyed map that grows with the run (a row per finding, per stage,
// per SQL write); everything else in the result is a fixed-size block that stays on the first page.
const SECTIONS = ['findings', 'cleanChecks', 'notRunChecks', 'stages', 'writes'] as const;
type Section = typeof SECTIONS[number];

type Item = { section: Section; key?: string; value: unknown };

export interface DiagnosePagination {
  /** 1 for the first page. */
  page: number;
  pageChars: number;
  /** Rows the whole result holds per paged list, so a client knows how much is left. */
  totals: Partial<Record<Section, number>>;
  /** Pass as `cursor` for the next page; null on the last one. */
  nextCursor: string | null;
}

// The first page has the whole result's shape with shorter lists. A later page holds only the
// identifiers and the rows it carries, in the same places the first page puts them.
export type DiagnosePage = (DiagnoseRunResult | Partial<DiagnoseRunResult> & { runId: string }) & { pagination: DiagnosePagination };

const jsonLength = (value: unknown): number => JSON.stringify(value).length;

function itemsOf(result: DiagnoseRunResult): Item[] {
  return [
    ...result.findings.map((value): Item => ({ section: 'findings', value })),
    ...(result.cleanChecks ?? []).map((value): Item => ({ section: 'cleanChecks', value })),
    ...(result.notRunChecks ?? []).map((value): Item => ({ section: 'notRunChecks', value })),
    ...Object.entries(result.metrics.stages).map(([key, value]): Item => ({ section: 'stages', key, value })),
    ...result.writeTargets.writes.map((value): Item => ({ section: 'writes', value })),
  ];
}

// Keeps each paged list in the shape the full result gives it, holding only `items`.
function withRows(result: DiagnoseRunResult, items: Item[]): DiagnoseRunResult {
  const rows = (section: Section) => items.filter((item) => item.section === section);
  return {
    ...result,
    findings: rows('findings').map((item) => item.value) as DiagnoseRunResult['findings'],
    ...(result.cleanChecks ? { cleanChecks: rows('cleanChecks').map((item) => item.value) as NonNullable<DiagnoseRunResult['cleanChecks']> } : {}),
    ...(result.notRunChecks ? { notRunChecks: rows('notRunChecks').map((item) => item.value) as NonNullable<DiagnoseRunResult['notRunChecks']> } : {}),
    metrics: { ...result.metrics, stages: Object.fromEntries(rows('stages').map((item) => [item.key!, item.value])) as DiagnoseRunResult['metrics']['stages'] },
    writeTargets: { ...result.writeTargets, writes: rows('writes').map((item) => item.value) as DiagnoseRunResult['writeTargets']['writes'] },
  };
}

// The cursor names the page it starts and a hash of the run and every row it was cut from, so one
// issued for a different run, filters, view or redaction is refused instead of serving rows from the wrong list.
interface Cursor { offset: number; page: number; fingerprint: string }

const fingerprintOf = (runId: string, items: Item[]): string => `${runId}:${items.length}:${fnv1a(JSON.stringify(items))}`;
const encodeCursor = (cursor: Cursor): string => Buffer.from(JSON.stringify(cursor)).toString('base64url');

function decodeCursor(text: string, fingerprint: string): Cursor {
  let cursor: Partial<Cursor> | null = null;
  try {
    cursor = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as Partial<Cursor>;
  } catch { /* falls through to the refusal below */ }
  const valid = cursor !== null && typeof cursor === 'object' && Number.isInteger(cursor.offset) && Number.isInteger(cursor.page)
    && cursor.fingerprint === fingerprint && cursor.offset! >= 0 && cursor.page! >= 2;
  if (!valid) throw mcpError('invalid-cursor', 'The cursor does not belong to this run and these filters. Use the nextCursor of a page of the same call, or omit cursor for the first page.');
  return cursor as Cursor;
}

/** Cuts a `diagnose_run` result into pages of about `pageChars` characters of JSON each.
 * A result that fits one page, with no cursor, is returned as it is. Otherwise the first page holds
 * the fixed blocks (verdict, recommendations, effectiveConf and the totals of `metrics`) and as many
 * rows as fit, and every page names the cursor of the next one. A later page always holds a row. */
export function paginateDiagnose(
  result: DiagnoseRunResult, { cursor, pageChars = DEFAULT_PAGE_CHARS }: { cursor?: string; pageChars?: number } = {},
): DiagnoseRunResult | DiagnosePage {
  const items = itemsOf(result);
  if (cursor === undefined && jsonLength(result) <= pageChars) return result;

  const fingerprint = fingerprintOf(result.runId, items);
  const { offset, page } = cursor === undefined ? { offset: 0, page: 1 } : decodeCursor(cursor, fingerprint);
  const totals: DiagnosePagination['totals'] = { findings: result.findings.length };
  for (const section of SECTIONS) {
    const count = items.filter((item) => item.section === section).length;
    if (count > 0) totals[section] = count;
  }
  const build = (rows: Item[], nextCursor: string | null): DiagnosePage => {
    const pagination: DiagnosePagination = { page, pageChars, totals, nextCursor };
    if (page === 1) return { ...withRows(result, rows), pagination };
    const has = (section: Section) => rows.some((item) => item.section === section);
    const held = withRows(result, rows);
    return {
      runId: result.runId, view: result.view, runComplete: result.runComplete,
      ...(has('findings') ? { findings: held.findings } : {}),
      ...(has('cleanChecks') ? { cleanChecks: held.cleanChecks } : {}),
      ...(has('notRunChecks') ? { notRunChecks: held.notRunChecks } : {}),
      ...(has('stages') ? { metrics: { stages: held.metrics.stages } as DiagnoseRunResult['metrics'] } : {}),
      ...(has('writes') ? { writeTargets: { writes: held.writeTargets.writes } as DiagnoseRunResult['writeTargets'] } : {}),
      pagination,
    };
  };

  // The page without rows, and a cursor as long as a real one, give the size the rows start from.
  let used = jsonLength(build([], encodeCursor({ offset: items.length, page: page + 1, fingerprint })));
  const taken: Item[] = [];
  let next = offset;
  while (next < items.length) {
    const item = items[next]!;
    const rowChars = jsonLength(item.value) + (item.key?.length ?? 0) + 4;
    // The first page may hold no row when its fixed blocks fill the budget: the next page starts without them.
    const mustTake = page > 1 && taken.length === 0;
    if (!mustTake && used + rowChars > pageChars) break;
    taken.push(item);
    used += rowChars;
    next++;
  }
  return build(taken, next < items.length ? encodeCursor({ offset: next, page: page + 1, fingerprint }) : null);
}
