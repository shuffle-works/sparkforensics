import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ThresholdOverrides } from './detectors.ts';
import type { ReportGenerator } from './run-output.ts';
import { mcpToolEntries, type McpToolEntry } from './mcp-tool-table.ts';

// The handshake version of a server built without a `generator`: no package to read a version from.
const UNKNOWN_VERSION = '0.0.0';

/** The tools the server registers, by name: the names of the table in `mcp-tool-table.ts`. */
export const MCP_TOOL_NAMES: readonly string[] = mcpToolEntries().map((entry) => entry.name);

/** Throws when the tools registered on the server differ from the entries of the table, so a tool
 * cannot be added to or dropped from one without the other. */
export function assertToolsMatchTable(registered: Iterable<string>, entries: readonly McpToolEntry[]): void {
  const registeredNames = new Set(registered);
  const tableNames = new Set(entries.map((entry) => entry.name));
  if (registeredNames.size !== tableNames.size || [...registeredNames].some((name) => !tableNames.has(name))) {
    throw new Error(`createMcpServer registers [${[...registeredNames].sort()}] but the tool table lists [${[...tableNames].sort()}].`);
  }
}

/** `thresholds`: the bin's --thresholds overrides, applied to every analyzing tool for the life
 * of the server. Omitted, every tool runs the specification defaults.
 * `defaultShsBaseUrl`: the History Server a `source` or `list_runs` call without `shsBaseUrl` uses.
 * `generator`: the host package's name, version and core build id. The server reports its version
 * in the MCP handshake and every diagnose_run and compare_runs result carries the block. */
export function createMcpServer(
  { thresholds, generator, defaultShsBaseUrl }: { thresholds?: ThresholdOverrides; generator?: ReportGenerator; defaultShsBaseUrl?: string } = {},
): McpServer {
  const server = new McpServer({ name: 'sparkforensics', version: generator?.version ?? UNKNOWN_VERSION });
  const entries = mcpToolEntries({ thresholds, generator, defaultShsBaseUrl });
  const registered = new Set<string>();
  for (const entry of entries) {
    registered.add(entry.name);
    // Loose, so a key a schema does not list is allowed in structuredContent.
    server.registerTool(entry.name, {
      description: entry.description, inputSchema: entry.inputSchema, outputSchema: z.looseObject(entry.outputSchema),
    }, entry.handler as never);
  }
  assertToolsMatchTable(registered, entries);
  return server;
}
