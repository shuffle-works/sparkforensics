import type { ReactNode } from 'react';
import { useWidgetDensity } from '@/store/store';

/** Wraps meta/caveat/reference-only content that should only render at the
 * Advanced density tier. Renders nothing at Basic. Basic tier keeps a widget's
 * finding and headline metric visible while trimming the supporting detail
 * (captions, confidence markers, cross-links, legends) that isn't needed to
 * act on the finding. Never gates a widget's core row/chart body: tier
 * filters only meta/caveat/reference content inside it. */
export function AdvancedOnly({ children }: { children: ReactNode }) {
  const density = useWidgetDensity();
  if (density !== 'advanced') return null;
  return <>{children}</>;
}
