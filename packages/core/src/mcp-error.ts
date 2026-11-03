/** Every code an MCP tool error carries in `structuredContent.code`. `invalid-argument` is a caller
 * mistake to correct before retrying; `access-or-upstream-failure` and `upstream-unreachable` are
 * worth a retry or a report. Published in docs-site/user-guide/mcp-tools.md. */
export const MCP_ERROR_CODES = [
  'invalid-argument',
  'invalid-event-log',
  'invalid-type',
  'invalid-anchor',
  'invalid-cursor',
  'invalid-date-filter',
  'invalid-shs-base-url',
  'run-not-found',
  'finding-not-found',
  'directory-not-found',
  'application-not-found',
  'archive-too-large',
  'upstream-unreachable',
  'access-or-upstream-failure',
] as const;

export type McpErrorCode = typeof MCP_ERROR_CODES[number];

export function isMcpErrorCode(value: unknown): value is McpErrorCode {
  return typeof value === 'string' && (MCP_ERROR_CODES as readonly string[]).includes(value);
}

/** A code a worker or the SHS proxy reported, or `fallback` when it is none of ours. */
export function toMcpErrorCode(value: unknown, fallback: McpErrorCode): McpErrorCode {
  return isMcpErrorCode(value) ? value : fallback;
}

export function mcpError(code: McpErrorCode, message: string): Error & { code: McpErrorCode } {
  return Object.assign(new Error(message), { code });
}
