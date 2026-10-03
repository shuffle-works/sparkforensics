// Delta write commands whose root node is a bare name in sparkPlanInfo on real logs. The parser keeps
// their `Arguments:` line (event-handlers.ts) and delta-targets.ts reads their target from it; the
// handler table there is typed by this list, so a command added here must get a handler.
export const DELTA_COMMANDS = [
  'MergeIntoCommand', 'UpdateCommand', 'DeleteCommand', 'WriteIntoDelta', 'WriteIntoDeltaCommand',
  'SaveIntoDataSourceCommand',
] as const;

export type DeltaCommand = (typeof DELTA_COMMANDS)[number];

export function isDeltaCommand(name: string): name is DeltaCommand {
  return (DELTA_COMMANDS as readonly string[]).includes(name);
}
