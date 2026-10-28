import { ArrowRight } from 'lucide-react';
import { DETECTOR_CATALOG_URL, detectorPageUrl } from '@sparkforensics/core/docs-site-config.ts';
import { titleCase } from '@sparkforensics/core/finding-names.ts';
import { FINDING_PRESENTATION } from '@sparkforensics/core/finding-presentation.ts';
import type { FindingType } from '@sparkforensics/core/types.ts';
import { TagBadge } from '@/view/ImpactBadge';

// Typed as FindingType so renaming a type breaks the build here.
const STRIP_TYPES: FindingType[] = ['skew', 'spill', 'shuffle', 'gc', 'coldStart', 'utilization', 'smallFiles', 'jobFailureRate'];

/** A sample of what the analysis flags, each linking to its catalog page, with
 * a link on to the full catalog. Sits below the hero so the intake stays in the
 * first viewport. */
export function DetectorStrip() {
  const detectorCount = Object.keys(FINDING_PRESENTATION).length;
  return (
    <section className="landing-detectors" aria-labelledby="detector-strip-title">
      <h2 id="detector-strip-title">What it finds</h2>
      <ul className="landing-detector-list">
        {STRIP_TYPES.map((type) => {
          const { name, pitch } = FINDING_PRESENTATION[type];
          return (
            <li key={type}>
              <a href={detectorPageUrl(type)} target="_blank" rel="noopener noreferrer" className="landing-detector-card">
                <TagBadge type={type} impactBand="info" plainBadge />
                <strong>{titleCase(name)}</strong>
                <span>{pitch}</span>
              </a>
            </li>
          );
        })}
      </ul>
      <a href={DETECTOR_CATALOG_URL} target="_blank" rel="noopener noreferrer" className="landing-detector-all tap-target-comfortable">
        See all {detectorCount} detectors <ArrowRight aria-hidden="true" />
      </a>
    </section>
  );
}
