import type { Finding } from '@sparkforensics/core/types.ts';
import { REGISTRY } from '@/view/detector-registry';
import { coreFindingActionLabel } from '@sparkforensics/core/finding-action-label.ts';

/** A short, imperative action label for a finding's row (e.g. "Reduce
 * shuffle size"), rendered above the finding's own full `recommendation`
 * sentence. The actual (type, discriminant) switch lives in the core
 * `coreFindingActionLabel` (`src/finding-action-label.ts`, no `src/view/**`
 * import, shared with `src/evidence-report.ts`'s CLI/MCP path); this wrapper
 * only adds the view-only fallback for a (type, variant) combination that
 * switch doesn't cover: the registry's per-type label, then the raw type. */
export function findingActionLabel(finding: Finding): string {
  return coreFindingActionLabel(finding) ?? REGISTRY[finding.type]?.findingLabel ?? finding.type;
}
