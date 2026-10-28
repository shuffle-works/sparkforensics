// `sparkforensics-analyze detectors`: prints the detector catalog (detector-catalog.ts), the same
// records the `list_detectors` MCP tool returns. Pure: it parses the arguments and returns what the
// bin should write, so the bin owns stdout, stderr and the exit code.
import { parseArgs } from 'node:util';
import { listDetectors, renderDetectorCatalogMarkdown } from '../detector-catalog.ts';
import { FINDING_TYPES } from './flag-values.ts';

export const DETECTORS_USAGE = `Usage: sparkforensics-analyze detectors [options]

Lists every finding type the detectors can report, with no event log: its tag, outcome family,
scope, fix effort, one-sentence description, default thresholds, docs paths and the budget flag
that gates it, when it has one. The JSON is the same record list the list_detectors MCP tool returns.

Options:
  --type <type>            Only this finding type.
  --format md|json         Output format (default: json).
  --help                   Print this help.

Exit codes: 0 ok, 2 usage error (bad flags or values).
`;

export interface DetectorsCommandResult {
  exitCode: 0 | 2;
  stdout: string;
  stderr: string;
}

const usageError = (message: string): DetectorsCommandResult => ({ exitCode: 2, stdout: '', stderr: `${message}\n${DETECTORS_USAGE}` });

export function runDetectorsCommand(argv: readonly string[]): DetectorsCommandResult {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { type: { type: 'string' }, format: { type: 'string' }, help: { type: 'boolean' } },
    }));
  } catch (e) {
    return usageError((e as Error).message);
  }
  if (values.help) return { exitCode: 0, stdout: DETECTORS_USAGE, stderr: '' };
  if (positionals.length > 0) return usageError(`detectors takes no argument, got "${positionals[0]}". Pass a log to analyze it instead.`);
  if (values.type !== undefined && !FINDING_TYPES.includes(values.type)) {
    return usageError(`--type: unknown value "${values.type}" (expected one of: ${FINDING_TYPES.join(', ')}).`);
  }
  const format = values.format ?? 'json';
  if (format !== 'json' && format !== 'md') return usageError('Invalid value for --format (expected "json" or "md").');

  const result = listDetectors(values.type);
  const stdout = format === 'md' ? renderDetectorCatalogMarkdown(result.detectors) : `${JSON.stringify(result, null, 2)}\n`;
  return { exitCode: 0, stdout, stderr: '' };
}
