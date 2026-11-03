import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ThresholdOverrides } from './detectors.ts';
import type { ReportGenerator } from './run-output.ts';
import { mcpToolEntries } from './mcp-tool-table.ts';

// The handshake version of a server built without a `generator`: no package to read a version from.
const UNKNOWN_VERSION = '0.0.0';

/** The tools the server registers, by name: the names of the table in `mcp-tool-table.ts`. */
export const MCP_TOOL_NAMES: readonly string[] = mcpToolEntries().map((entry) => entry.name);

/** `thresholds`: the bin's --thresholds overrides, applied to every analyzing tool for the life
 * of the server. Omitted, every tool runs the specification defaults.
 * `defaultShsBaseUrl`: the History Server a `source` or `list_runs` call without `shsBaseUrl` uses.
 * `generator`: the host package's name, version and core build id. The server reports its version
 * in the MCP handshake and every diagnose_run and compare_runs result carries the block. */
export function createMcpServer(
  { thresholds, generator, defaultShsBaseUrl }: { thresholds?: ThresholdOverrides; generator?: ReportGenerator; defaultShsBaseUrl?: string } = {},
): McpServer {
  const server = new McpServer({ name: 'sparkforensics', version: generator?.version ?? UNKNOWN_VERSION });
  for (const entry of mcpToolEntries({ thresholds, generator, defaultShsBaseUrl })) {
    // Loose, so a key a schema does not list is allowed in structuredContent. An error result carries
    // only `{ code }`, and an MCP client checks it against this schema too (the SDK needs an object
    // schema, so no union): every success field is optional and `code` is declared.
    server.registerTool(entry.name, {
      description: entry.description,
      inputSchema: entry.inputSchema,
      outputSchema: z.looseObject({ ...z.object(entry.outputSchema).partial().shape, code: z.string().optional() }),
    }, entry.handler as never);
  }
  return server;
}
