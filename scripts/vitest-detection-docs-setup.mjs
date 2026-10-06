// vitest globalSetup for packages whose tests read the gitignored
// packages/core/src/docs-content/detection/ (the MCP get_finding_documentation
// tool). Idempotent.
import { ensureDetectionDocs } from './split-detection-docs.mjs';

export default function setup() {
  ensureDetectionDocs();
}
