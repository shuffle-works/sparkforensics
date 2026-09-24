// What actually went wrong behind a failed task attempt, read from its TaskEnd "Task End Reason".
// Spark's `Reason` is only the end-reason tag (ExceptionFailure, ExecutorLostFailure, ...); the
// real error lives in tag-specific fields (JsonProtocol.taskEndReasonToJson):
//   ExceptionFailure     Class Name, Description, Full Stack Trace
//   ExecutorLostFailure  Loss Reason (e.g. "Container killed by YARN for exceeding memory limits")
//   FetchFailed          Message (often a whole exception string, stack included)
//   TaskKilled           Kill Reason
// Every text field is bounded here, at ingest, so neither parser memory nor a report grows with
// the size of the traces Spark wrote.

export interface TaskFailureDetail {
  reason: string | null;
  className: string | null;
  message: string | null;
  lossReason: string | null;
  stackExcerpt: string | null;
}

export interface TaskFailureGroup extends TaskFailureDetail {
  count: number;
}

const MAX_TEXT_CHARS = 300;
const MAX_EXCERPT_FRAMES = 8;
const MAX_EXCERPT_LINE_CHARS = 300;
const MAX_EXCERPT_CHARS = 2000;
// Distinct failures kept per stage while parsing, and shown per finding.
export const MAX_FAILURE_DETAILS_PER_STAGE = 50;
export const MAX_FAILURE_GROUPS = 5;

export const REDACTED_TEXT = '[redacted]';

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

// First non-blank line, whitespace collapsed: a message can carry a whole stack trace after it.
function firstLine(s: string | null): string | null {
  if (s == null) return null;
  const line = s.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  return line ? truncate(line.replace(/\s+/g, ' '), MAX_TEXT_CHARS) : null;
}

/** Header line, the first frames, and (when cut off) the last `Caused by:` line, which usually
 * names the root cause. Bounded by frame count, line length and total length. */
export function buildStackExcerpt(trace: string | null): string | null {
  if (trace == null) return null;
  const lines = trace.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;
  const headCount = 1 + MAX_EXCERPT_FRAMES;
  const kept = lines.slice(0, headCount);
  if (lines.length > headCount) {
    let causeIdx = -1;
    for (let i = lines.length - 1; i >= headCount; i--) {
      if (lines[i].startsWith('Caused by:')) { causeIdx = i; break; }
    }
    kept.push('\t...');
    if (causeIdx >= 0) kept.push(...lines.slice(causeIdx, causeIdx + 2));
  }
  return truncate(kept.map((l) => truncate(l, MAX_EXCERPT_LINE_CHARS)).join('\n'), MAX_EXCERPT_CHARS);
}

/** Bounded failure detail for a failed attempt's end reason, or null when there is no end reason. */
export function extractTaskFailureDetail(endReason: Record<string, unknown> | undefined): TaskFailureDetail | null {
  if (!endReason) return null;
  const reason = text(endReason['Reason']);
  const rawMessage = text(endReason['Description']) ?? text(endReason['Message']) ?? text(endReason['Kill Reason']);
  // FetchFailed has no Full Stack Trace field, but its Message is a full exception string.
  const trace = text(endReason['Full Stack Trace'])
    ?? (rawMessage != null && rawMessage.trim().includes('\n') ? rawMessage : null);
  return {
    reason,
    className: firstLine(text(endReason['Class Name'])),
    message: firstLine(rawMessage),
    lossReason: firstLine(text(endReason['Loss Reason'])),
    stackExcerpt: buildStackExcerpt(trace),
  };
}

/** Grouping key: one group per distinct error. The excerpt is left out, so two traces of the same
 * error share a group and the first one seen is kept. */
export function taskFailureKey(d: TaskFailureDetail): string {
  return JSON.stringify([d.reason, d.className, d.message, d.lossReason]);
}

/** Short name for the error: the exception class, or the end-reason tag with its loss reason. */
export function describeTaskFailure(d: TaskFailureDetail): string | null {
  if (d.className) return d.className;
  if (d.lossReason) return d.reason ? `${d.reason}: ${d.lossReason}` : d.lossReason;
  return d.reason;
}

const FRAME_LINE = /^\s*(?:at \S.*|\.\.\.(?: \d+ more)?)$/;
const CLASS_HEADER = /^((?:Caused by: |Suppressed: )?[\w$]+(?:\.[\w$]+)+)(?::.*)?$/;

// Keeps stack frames and exception class names only: a message (the text after "Class: ", and any
// continuation line such as a Python traceback's `File "/path"` lines) is dropped.
function stripExcerptMessages(excerpt: string): string {
  const kept: string[] = [];
  for (const line of excerpt.split('\n')) {
    if (FRAME_LINE.test(line)) { kept.push(line); continue; }
    const header = CLASS_HEADER.exec(line.trim());
    if (header) kept.push(header[1]);
  }
  return kept.join('\n');
}

/** Redacted copy of a failure group: the message and the message text inside the stack excerpt
 * can carry file paths and data values. Class names, frames and the loss reason are kept (hosts in
 * a loss reason are pseudonymized by the caller's host scan like any other free text). */
export function redactTaskFailureGroup<T extends TaskFailureDetail>(g: T): T {
  return {
    ...g,
    message: g.message == null ? null : REDACTED_TEXT,
    stackExcerpt: g.stackExcerpt == null ? null : stripExcerptMessages(g.stackExcerpt),
  };
}

/** One-line headline for a failure group, for reports and the Failed Tasks widget. */
export function formatTaskFailureHeadline(d: TaskFailureDetail): string {
  const name = d.className ?? d.reason ?? 'Unknown failure';
  const detail = [d.message, d.lossReason].filter((s): s is string => s != null).join(' · ');
  return detail ? `${name}: ${detail}` : name;
}
