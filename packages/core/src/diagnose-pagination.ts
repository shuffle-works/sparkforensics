import { fnv1a } from './analyzer.ts';
import { mcpError } from './mcp-error.ts';
import type { DiagnoseRunResult } from './mcp-tools.ts';

export const DEFAULT_PAGE_CHARS = 50_000;

// The lists that grow with the run, in the order their rows are served.
const SECTIONS = ['findings', 'cleanChecks', 'notRunChecks', 'stages', 'writes'] as const;
type Section = typeof SECTIONS[number];
type Item = { section: Section; key?: string; value: unknown };

interface Pagination {
  page: number;
  pageChars: number;
  /** Rows per paged list in the whole result. */
  totals: Partial<Record<Section, number>>;
  /** The `cursor` of the next page; null on the last one. */
  nextCursor: string | null;
}

// A cursor holds a hash of the run and its rows, so one from other filters, view or redaction is refused.
interface Cursor { offset: number; page: number; fingerprint: string }

const jsonLength = (value: unknown): number => JSON.stringify(value).length;
const encodeCursor = (cursor: Cursor): string => Buffer.from(JSON.stringify(cursor)).toString('base64url');

function decodeCursor(text: string, fingerprint: string): Cursor {
  let cursor: Partial<Cursor> = {};
  try {
    cursor = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch { /* refused below */ }
  if (!Number.isInteger(cursor.offset) || cursor.offset! < 0 || !Number.isInteger(cursor.page) || cursor.page! < 2 || cursor.fingerprint !== fingerprint) {
    throw mcpError('invalid-cursor', 'The cursor does not belong to this run and these filters. Use the nextCursor of a page of the same call, or omit cursor for the first page.');
  }
  return cursor as Cursor;
}

function itemsOf(result: DiagnoseRunResult): Item[] {
  return [
    ...result.findings.map((value): Item => ({ section: 'findings', value })),
    ...(result.cleanChecks ?? []).map((value): Item => ({ section: 'cleanChecks', value })),
    ...(result.notRunChecks ?? []).map((value): Item => ({ section: 'notRunChecks', value })),
    ...Object.entries(result.metrics.stages).map(([key, value]): Item => ({ section: 'stages', key, value })),
    ...result.writeTargets.writes.map((value): Item => ({ section: 'writes', value })),
  ];
}

/** Cuts a JSON `diagnose_run` result into pages of about `pageChars` characters. A result that
 * fits one page and has no cursor is returned as it is. Otherwise the first page keeps the fixed
 * blocks (verdict, recommendations, effectiveConf, the totals of `metrics`) with as many rows as
 * fit. A later page holds only `runId`, `view`, `runComplete` and its rows, and always one row. */
export function paginateDiagnose(
  result: DiagnoseRunResult, { cursor, pageChars = DEFAULT_PAGE_CHARS }: { cursor?: string; pageChars?: number } = {},
): DiagnoseRunResult | (Partial<DiagnoseRunResult> & { pagination: Pagination }) {
  if (result.markdown !== undefined || (cursor === undefined && jsonLength(result) <= pageChars)) return result;

  const items = itemsOf(result);
  const fingerprint = `${result.runId}:${fnv1a(JSON.stringify(items))}`;
  const { offset, page } = cursor === undefined ? { offset: 0, page: 1 } : decodeCursor(cursor, fingerprint);
  const totals: Pagination['totals'] = { findings: result.findings.length };
  for (const section of SECTIONS) {
    const count = items.filter((item) => item.section === section).length;
    if (count > 0) totals[section] = count;
  }

  const build = (rows: Item[], nextCursor: string | null) => {
    const list = (section: Section) => rows.filter((item) => item.section === section).map((item) => item.value);
    const stages = Object.fromEntries(rows.filter((item) => item.section === 'stages').map((item) => [item.key!, item.value]));
    const pagination: Pagination = { page, pageChars, totals, nextCursor };
    if (page === 1) {
      return {
        ...result, findings: list('findings'),
        ...(result.cleanChecks && { cleanChecks: list('cleanChecks') }),
        ...(result.notRunChecks && { notRunChecks: list('notRunChecks') }),
        metrics: { ...result.metrics, stages }, writeTargets: { ...result.writeTargets, writes: list('writes') }, pagination,
      } as DiagnoseRunResult & { pagination: Pagination };
    }
    const has = (section: Section) => rows.some((item) => item.section === section);
    return {
      runId: result.runId, view: result.view, runComplete: result.runComplete,
      ...(has('findings') && { findings: list('findings') }),
      ...(has('cleanChecks') && { cleanChecks: list('cleanChecks') }),
      ...(has('notRunChecks') && { notRunChecks: list('notRunChecks') }),
      ...(has('stages') && { metrics: { stages } }),
      ...(has('writes') && { writeTargets: { writes: list('writes') } }),
      pagination,
    } as Partial<DiagnoseRunResult> & { pagination: Pagination };
  };

  // Rows are added to the size of the page without rows, with a cursor as long as a real one.
  let used = jsonLength(build([], encodeCursor({ offset: items.length, page: page + 1, fingerprint })));
  const taken: Item[] = [];
  let next = offset;
  while (next < items.length) {
    const item = items[next]!;
    const rowChars = jsonLength(item.value) + (item.key?.length ?? 0) + 4;
    // A later page takes one row even over budget, so every page advances.
    if (used + rowChars > pageChars && (page === 1 || taken.length > 0)) break;
    taken.push(item);
    used += rowChars;
    next++;
  }
  return build(taken, next < items.length ? encodeCursor({ offset: next, page: page + 1, fingerprint }) : null);
}
