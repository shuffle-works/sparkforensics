import { ArrowRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useStore } from '@/store/store';
import { useIngest } from '@/store/useIngest';
import { useOptionalDocs } from '@/view/DocsContext';
import { ALTERNATIVE_LOG_RETRIEVAL_URL } from '@/view/DropZone';
import { SAMPLE_RUN_ID } from '@/view/sample-run';

/** One line above the verdict while the bundled sample run is open: a
 * newcomer who clicked "Try a sample run" should know the board shows the
 * sample, not their own job, and how to get from here to their own log. */
export function SampleRunNotice() {
  const activeFileId = useStore((s) => s.activeFileId);
  const exportMode = useStore((s) => s.exportMode);
  const { resetToDropZone } = useIngest();
  const docs = useOptionalDocs();
  if (exportMode || activeFileId !== SAMPLE_RUN_ID) return null;

  return (
    <section
      aria-label="Sample run"
      data-testid="sample-run-notice"
      className="flex flex-col gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="max-w-prose">
        <span className="font-medium">This is the sample run</span>, a real Spark job from a public example corpus,
        picked because it shows several common problems. Everything below works the same on your own event log.
      </p>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={resetToDropZone}>
          Load my event log
          <ArrowRight aria-hidden="true" />
        </Button>
        <a
          href={ALTERNATIVE_LOG_RETRIEVAL_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="tap-target-comfortable inline-flex items-center rounded-sm px-2 text-primary underline-offset-4 hover:underline"
          onClick={(event) => {
            // Same passthrough as every other in-app docs link: a modified or
            // non-primary click keeps the browser's own new-tab behavior.
            if (!docs || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            docs.openSite(ALTERNATIVE_LOG_RETRIEVAL_URL);
          }}
        >
          Where do I find my log?
        </a>
      </div>
    </section>
  );
}
