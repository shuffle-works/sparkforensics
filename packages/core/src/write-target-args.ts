// Argument and identifier helpers shared by the write-target parsers (write-targets.ts) and the
// Delta command resolver (delta-targets.ts).
const IDENT_PART = String.raw`(?:\`(?:[^\`]|\`\`)*\`|[A-Za-z0-9_$]+)`;
const IDENTIFIER = new RegExp(`^${IDENT_PART}(?:\\.${IDENT_PART})*$`);
export const IDENT_PARTS = new RegExp(IDENT_PART, 'g');
const TRUNCATION_MARKER = /\.\.\.(?:\s*\d+ more fields)?/;

export interface Arg { text: string; terminated: boolean }

// Splits at top-level commas, ignoring commas inside (), [], {} and backticks. `terminated` is
// true when a comma follows the arg: the last arg of a cut-off string is never terminated.
export function splitArgs(args: string): Arg[] {
  const out: Arg[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '`') quoted = !quoted;
    else if (quoted) continue;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push({ text: args.slice(start, i).trim(), terminated: true });
      start = i + 1;
    }
  }
  out.push({ text: args.slice(start).trim(), terminated: false });
  return out;
}

export function isCut(text: string): boolean {
  return text === '' || TRUNCATION_MARKER.test(text);
}

// `db`.`t` or db.t -> db.t. A part that itself contains a dot or backtick keeps its quoting.
export function tableName(ident: string): string | null {
  if (!IDENTIFIER.test(ident)) return null;
  const parts = (ident.match(IDENT_PARTS) ?? []).map((p) => {
    if (!p.startsWith('`')) return p;
    const inner = p.slice(1, -1).replace(/``/g, '`');
    return /[.`]/.test(inner) ? p : inner;
  });
  return parts.join('.');
}
