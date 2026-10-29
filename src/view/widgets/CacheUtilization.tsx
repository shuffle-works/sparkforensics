import { useMemo } from 'react';

import { formatBytes, numericValue } from '@sparkforensics/core/format-utils.ts';
import { DocsLink } from '@/view/DocsContext';
import { defineFindingWidget, type FindingRowProps, type FindingWidgetView } from '@/view/finding-widget';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { ImpactDot } from '@/view/ImpactBadge';
import { WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import { cacheUtilizationModel, cachedRdds, rddInfoOf, type CacheRow } from './CacheUtilization.rows';
import { CachedRddTable } from './CachedRddTable';

/** One flagged RDD finding's row. The row shows its measured detail and the card states the fix once; a
 * storageUnobserved caveat has no shared fix, so its row keeps its own text. */
function Row({ row: { finding, label, detail, stated } }: FindingRowProps<CacheRow>) {
  return (
    <>
      <p className="flex flex-wrap items-start gap-2">
        <ImpactDot impactBand={finding.impactBand} className="mt-1.5" />
        <span>{label}</span>
      </p>
      <p className="text-xs text-muted-foreground">{detail}</p>
      {stated ? null : <ImpactEstimate finding={finding} />}
    </>
  );
}

/** The table of cached RDDs, each marked with the worst band of the findings on it. */
const Lead: NonNullable<FindingWidgetView<CacheRow>['Lead']> = ({ appModel, rows }) => {
  const rddInfo = rddInfoOf(appModel);
  // Cached-RDD rows depend only on `rddInfo`; memoized to skip recompute on unrelated re-renders.
  const rdds = useMemo(() => cachedRdds(rddInfo), [rddInfo]);
  const findings = rows.flatMap((row) => row.findings);

  return (
    <div data-widget="cache-utilization">
      <p className="text-xs text-muted-foreground">
        {rdds.length > 0 ? `${rdds.length} cached RDD${rdds.length === 1 ? '' : 's'}` : 'cache storage not logged'}, see{' '}
        <DocsLink anchor="#memory-model">how Spark accounts cached memory</DocsLink>
      </p>
      {rdds.length > 0 ? (
        <>
          <CachedRddTable rdds={rdds} findings={findings} />
        </>
      ) : null}
    </div>
  );
};

const Summary: NonNullable<FindingWidgetView<CacheRow>['Summary']> = ({ appModel, rows }) => {
  const rddInfo = rddInfoOf(appModel);
  const rdds = useMemo(() => cachedRdds(rddInfo), [rddInfo]);
  if (rdds.length > 0) {
    const totalBytes = rdds.reduce((sum, r) => sum + (r.memorySize ?? 0) + (r.diskSize ?? 0), 0);
    return <WidgetLeadSummary value={formatBytes(totalBytes)} context="cached across memory + disk" />;
  }
  // No cached RDDs: the card is there for the persisted ones with no storage evidence.
  const unobserved = rows.find((row) => row.caveat);
  return <WidgetLeadSummary value="Unknown" context={`${unobserved ? numericValue(unobserved.finding) : 0} persisted, no block updates`} />;
};

/** App-wide RDD cache/persist surfacing: the table of cached RDDs and a row for each flagged one. */
export const CacheUtilization = defineFindingWidget(cacheUtilizationModel, { Row, Lead, Summary });
