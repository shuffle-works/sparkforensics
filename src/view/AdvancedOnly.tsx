import type { ReactNode } from 'react';
import { useWidgetDensity } from '@/store/store';

/** Flip to true locally to outline AdvancedOnly content in red — useful for
 * spotting what's gated on the live site. Must stay false on commit. */
const DEBUG_HIGHLIGHT = false;

/** Wraps meta/caveat/reference-only content that should only render at the
 * Advanced density tier. Renders nothing at Basic. Basic tier keeps a widget's
 * finding and headline metric visible while trimming the supporting detail
 * (captions, confidence markers, cross-links, legends) that isn't needed to
 * act on the finding. Never gates a widget's core row/chart body: tier
 * filters only meta/caveat/reference content inside it. */
export function AdvancedOnly({ children }: { children: ReactNode }) {
  const density = useWidgetDensity();
  if (density !== 'advanced') return null;
  if (DEBUG_HIGHLIGHT) {
    return (
      <div style={{ outline: '2px solid red', backgroundColor: 'rgba(255, 0, 0, 0.15)' }}>
        {children}
      </div>
    );
  }
  return <>{children}</>;
}
