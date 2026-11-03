import type { Finding } from '@sparkforensics/core/types';
import { RowStatusCluster } from '@/view/RowStatusCluster';

/** The confidence marker of a SQL-plan card, on the header once: the findings' shared confidence, or
 * none when they differ, so it never shows one finding's confidence as if it applied to all. Advanced only. */
export function PlanRowStatus<R extends { finding: Finding }>({ rows, density }: { rows: readonly R[]; density: 'basic' | 'advanced' }) {
  if (density !== 'advanced') return null;
  const shared = rows.every(({ finding }) => finding.confidence === rows[0].finding.confidence) ? rows[0].finding : undefined;
  return <RowStatusCluster confidence={shared?.confidence} validationRequired={shared?.validationRequired} evidenceKey="sqlPlan" />;
}
