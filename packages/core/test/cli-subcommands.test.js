import { describe, it, expect } from 'vitest';
import { CLI_SUBCOMMANDS, subcommandUsageLines } from '../src/cli/subcommands.ts';

describe('CLI_SUBCOMMANDS', () => {
  it('names each subcommand once', () => {
    const names = CLI_SUBCOMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(CLI_SUBCOMMANDS.map((c) => [c.name, c]))('%s prints its own usage for --help and is listed in the bin usage', (name, command) => {
    expect(command.run(['--help'])).toEqual({ exitCode: 0, stdout: command.usage, stderr: '' });
    expect(command.usage).toMatch(new RegExp(`^Usage: sparkforensics-analyze ${name}`));
    expect(subcommandUsageLines()).toContain(`sparkforensics-analyze ${name} ${command.synopsis}   ${command.summary}`);
  });
});
