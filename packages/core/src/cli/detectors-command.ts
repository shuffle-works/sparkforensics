// `sparkforensics-analyze detectors`: prints the detector catalog (detector-catalog.ts), the same
// records the `list_detectors` MCP tool returns. Pure: it parses the arguments and returns what the
// bin should write, so the bin owns stdout, stderr, the exit code and the --out file.
import { parseArgs } from 'node:util';
import { catalogTags, listDetectors, renderDetectorCatalogMarkdown } from '../detector-catalog.ts';
import { DETECTOR_FAMILIES } from '../finding-presentation.ts';
import { FINDING_TYPES } from './flag-values.ts';
import { loadThresholdOverrides } from './threshold-config.ts';
import type { ThresholdOverrides } from '../detectors.ts';

const SCOPES = ['stage', 'app', 'sql', 'config'];

export const DETECTORS_USAGE = `Usage: sparkforensics-analyze detectors [options]

Lists every finding type the detectors can report, with no event log: its tag, outcome family,
scope, fix effort, one-sentence description, thresholds, docs paths and the budget flag that gates
it, when it has one. The JSON is the same record list the list_detectors MCP tool returns.

Options:
  --type <type>            Only this finding type.
  --tag <TAG>              Only the types with this tag (SKEW, PLAN, ...).
  --family <family>        Only this outcome family: ${DETECTOR_FAMILIES.map((f) => f.id).join(', ')}.
  --scope <scope>          Only detectors of this scope: ${SCOPES.join(', ')}.
  --format md|json         Output format (default: json).
  --out <path>             Write the output to a file instead of stdout.
  --thresholds <file>      Report the thresholds the detectors run with under the overrides in this
                           JSON file, the same file the analyze command reads.
  --help                   Print this help.

Exit codes: 0 ok, 2 usage error (bad flags, values or thresholds file).
`;

export interface DetectorsCommandResult {
  exitCode: 0 | 2;
  stdout: string;
  stderr: string;
  /** The --out path, when the caller asked for the output in a file. */
  outPath?: string;
}

const usageError = (message: string): DetectorsCommandResult => ({ exitCode: 2, stdout: '', stderr: `${message}\n${DETECTORS_USAGE}` });

// A flag value that must be one of a known list, or the usage error naming the list.
function oneOf(flag: string, value: string | undefined, known: readonly string[]): string | undefined {
  if (value !== undefined && !known.includes(value)) {
    throw new Error(`${flag}: unknown value "${value}" (expected one of: ${known.join(', ')}).`);
  }
  return value;
}

export function runDetectorsCommand(argv: readonly string[]): DetectorsCommandResult {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        type: { type: 'string' }, tag: { type: 'string' }, family: { type: 'string' }, scope: { type: 'string' },
        format: { type: 'string' }, out: { type: 'string' }, thresholds: { type: 'string' }, help: { type: 'boolean' },
      },
    }));
  } catch (e) {
    return usageError((e as Error).message);
  }
  if (values.help) return { exitCode: 0, stdout: DETECTORS_USAGE, stderr: '' };
  if (positionals.length > 0) return usageError(`detectors takes no argument, got "${positionals[0]}". Pass a log to analyze it instead.`);

  let filter;
  let thresholds: ThresholdOverrides | undefined;
  try {
    filter = {
      type: oneOf('--type', values.type, FINDING_TYPES),
      tag: oneOf('--tag', values.tag?.toUpperCase(), catalogTags()),
      family: oneOf('--family', values.family, DETECTOR_FAMILIES.map((f) => f.id)),
      scope: oneOf('--scope', values.scope, SCOPES),
    };
    if (values.thresholds !== undefined) thresholds = loadThresholdOverrides(values.thresholds);
  } catch (e) {
    return usageError((e as Error).message);
  }
  const format = values.format ?? 'json';
  if (format !== 'json' && format !== 'md') return usageError('Invalid value for --format (expected "json" or "md").');

  const result = listDetectors(filter, { thresholds });
  const stdout = format === 'md' ? renderDetectorCatalogMarkdown(result.detectors) : `${JSON.stringify(result, null, 2)}\n`;
  return { exitCode: 0, stdout, stderr: '', ...(values.out !== undefined ? { outPath: values.out } : {}) };
}
