import { ThemeProvider } from '@/theme/ThemeProvider';
import { DocsProvider } from '@/view/DocsContext';
import { EvidenceAvailabilityProvider } from '@/view/EvidenceAvailabilityContext';
import { StageDetailProvider } from '@/view/StageDetailContext';
import { FindingExample } from './FindingExample';

/** The docs example's providers: the ones the export bundle's dashboard gives a widget. */
export function DocsWidgetApp({ findingId }: { findingId: string }) {
  return (
    <ThemeProvider>
      <DocsProvider>
        <StageDetailProvider>
          <EvidenceAvailabilityProvider>
            <FindingExample findingId={findingId} />
          </EvidenceAvailabilityProvider>
        </StageDetailProvider>
      </DocsProvider>
    </ThemeProvider>
  );
}
