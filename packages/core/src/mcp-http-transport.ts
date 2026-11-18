// Re-exported so the local server has no third-party import of its own: every package it needs is
// imported from core, where the prepack bundler finds and bundles it.
export { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
