// The CLI's subcommands as one typed table: the bin dispatches by `name` and builds its usage
// lines from `synopsis` and `summary`, so a subcommand cannot be dispatched without being listed.
// A subcommand is a command only as the first argument; a log with its name is passed as ./name.
import { DETECTORS_USAGE, runDetectorsCommand } from './detectors-command.ts';

export interface CliSubcommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CliSubcommand {
  name: string;
  /** The arguments shown after the name in the bin's usage. */
  synopsis: string;
  /** The usage line's description. */
  summary: string;
  /** What `<name> --help` prints. */
  usage: string;
  /** Pure: parses the arguments and returns what the bin writes and exits with. */
  run(argv: readonly string[]): CliSubcommandResult;
}

export const CLI_SUBCOMMANDS: readonly CliSubcommand[] = [
  {
    name: 'detectors',
    synopsis: '[options]',
    summary: 'List what the detectors find; see "detectors --help".',
    usage: DETECTORS_USAGE,
    run: runDetectorsCommand,
  },
];

/** The bin's usage lines for the subcommands, one per entry. */
export function subcommandUsageLines(): string {
  return CLI_SUBCOMMANDS.map(({ name, synopsis, summary }) => `       sparkforensics-analyze ${name} ${synopsis}   ${summary}`).join('\n');
}
