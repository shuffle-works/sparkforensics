import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowRight, Bot, BookOpen, FileText, GitCompareArrows, Moon, ShieldCheck, Sun, TriangleAlert, Workflow } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { docsUrl } from '@sparkforensics/core/docs-config.ts';
import { DropZone } from '@/view/DropZone';
import { IMPACT_BORDER_CLASS } from '@/view/ImpactBadge';
import { cn } from '@/lib/utils';
import { McpSetupGuide } from '@/view/McpSetupGuide';
import { ProductBarPortal } from '@/view/ProductBarPortal';
import { store } from '@/store/store';
import { useIngest, type RunSource } from '@/store/useIngest';
import { useTheme } from '@/theme/ThemeProvider';

/** Styled replacement for the old bare `<p role="alert">`: a file-load error
 * (bad format, unreadable file, malformed rolling-log folder) now reads as a
 * real diagnostic card, matching the impact-band border every finding widget
 * already uses (`IMPACT_BORDER_CLASS.critical`), instead of a plain line of
 * red text easy to miss above the fold. Auto-focuses itself, mirroring the
 * SHS-fetch panel's existing error-focus pattern below. */
function FileLoadAlert({ message, nonce }: { message: string; nonce?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    // `nonce` also triggers this: two distinct failed attempts can produce the
    // exact same message text (e.g. "permission to read this file was
    // denied" retried), and `message` alone wouldn't detect that as a change.
  }, [message, nonce]);
  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      className={cn(
        'mb-4 flex items-start gap-3 rounded-lg border-l-4 bg-critical/10 p-4 text-sm text-foreground',
        IMPACT_BORDER_CLASS.critical,
      )}
    >
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-critical" />
      <p>{message}</p>
    </div>
  );
}

/** Relative, not `/docs/`: the app itself can be published under a subpath
 * (e.g. the hub's `/sparkforensics/`), and a leading slash would resolve
 * against the domain root instead of wherever this page actually loaded from. */
const DOCS_SITE_ROOT = 'docs/';

/** A filled compare slot: run label + change affordance, replacing the slot's
 * DropZone once a source is picked. */
function FilledSlot({ label, onChange }: { label: string; onChange: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-border p-4">
      <span className="min-w-0 truncate text-sm">
        <span aria-hidden="true" className="mr-2 text-clean">✓</span>
        {label}
      </span>
      <Button type="button" variant="ghost" size="sm" className="tap-target-comfortable" onClick={onChange}>Change</Button>
    </div>
  );
}

function Slot({ testId, ariaLabel, source, onPick, onChange }: {
  testId: string; ariaLabel: string;
  source: RunSource | null;
  onPick: (s: RunSource) => void;
  onChange: () => void;
}) {
  return (
    <div data-testid={testId} aria-label={ariaLabel} className="min-w-0 flex-1">
      {source ? <FilledSlot label={source.label} onChange={onChange} /> : <DropZone onPick={onPick} compact />}
    </div>
  );
}

function CompareAction({ onClick }: { onClick: () => void }) {
  return (
    <Button type="button" variant="outline" className="tap-target-comfortable" onClick={onClick}>
      Compare two runs <ArrowRight aria-hidden="true" />
    </Button>
  );
}

/** Labeled resource cards for first-time discovery in the hero. In
 * hub-embedded mode this hero isn't visible; the hub's own shared product
 * bar provides docs entry points there instead, so nothing here needs to
 * duplicate them. */
function ResourceLinks() {
  return (
    <div className="landing-resources" aria-label="SparkForensics resources">
      <a href={DOCS_SITE_ROOT} target="_blank" rel="noopener noreferrer" className="landing-resource-card">
        <FileText aria-hidden="true" />
        <span>
          <strong>Read the docs</strong>
          <span>How to load a log, read the board, and use every finding.</span>
        </span>
        <ArrowRight aria-hidden="true" className="landing-resource-arrow" />
      </a>
      <a href={docsUrl('#intro')} target="_blank" rel="noopener noreferrer" className="landing-resource-card">
        <BookOpen aria-hidden="true" />
        <span>
          <strong>Spark optimization reference</strong>
          <span>Architecture, memory, shuffle, and tuning notes behind every finding.</span>
        </span>
        <ArrowRight aria-hidden="true" className="landing-resource-arrow" />
      </a>
    </div>
  );
}

function NextStepsRail({ onCompare }: { onCompare: () => void }) {
  return (
    <section className="landing-next-steps" aria-labelledby="next-steps-title">
      <div>
        <h2 id="next-steps-title">After your first run, go further with the same evidence.</h2>
      </div>
      <div className="landing-next-step-list">
        <article>
          <GitCompareArrows aria-hidden="true" />
          <div>
            <h3>Compare two runs</h3>
            <p>Use a baseline and candidate log to see which structurally matched stages changed.</p>
            <CompareAction onClick={onCompare} />
          </div>
        </article>
        <article>
          <Bot aria-hidden="true" />
          <div>
            <h3>Use with an AI assistant</h3>
            <p>Connect MCP when you want an agent to inspect this evidence with you.</p>
            <McpSetupGuide />
          </div>
        </article>
        <article>
          <Workflow aria-hidden="true" />
          <div>
            <h3>Automate it in Airflow</h3>
            <p>Run this analysis after every Spark job with sparkforensics-operator instead of checking runs by hand.</p>
            <Button
              variant="outline"
              className="tap-target-comfortable"
              // Rendered as a real <a>, not a <button>: tell Base UI so it
              // doesn't assume native button keyboard/activation semantics
              // for an element that isn't one (fixes a console warning).
              nativeButton={false}
              render={<a href="https://github.com/shuffle-works/sparkforensics-operator" target="_blank" rel="noopener noreferrer" />}
            >
              View sparkforensics-operator <ArrowRight aria-hidden="true" />
            </Button>
          </div>
        </article>
      </div>
    </section>
  );
}

/** Landing surface: single DropZone by default; a "Compare two runs" toggle
 * switches to two deferred-capture slots. Compare enables once both slots hold
 * a RunSource, then drives the sequential two-run load. */
export function CompareLanding({ errorMessage, errorNonce }: { errorMessage?: string | null; errorNonce?: number } = {}) {
  const { startCompareLoad, drillIntoRun } = useIngest();
  const { theme, toggle } = useTheme();
  // A dashboard's "Compare with another run" leaves its run here as Run A.
  // It stays in the store until the comparison opens or the reader leaves
  // it, so a failed Run B load remounts this view still seeded.
  const [seed] = useState(() => store.getState().compareSeed);
  const [compareMode, setCompareMode] = useState(seed != null);
  const [a, setA] = useState<RunSource | null>(seed ? { kind: 'cached', ...seed } : null);
  const [b, setB] = useState<RunSource | null>(null);
  const seededRunKept = seed != null && a?.kind === 'cached' && a.id === seed.id;

  if (!compareMode) {
    return (
      <div className="landing-shell mx-auto w-full max-w-6xl">
        <section className="landing-hero" aria-labelledby="landing-title">
          <ProductBarPortal className="landing-identity">
            <Activity aria-hidden="true" className="size-4" />
            <span>SparkForensics</span>
            <button
              type="button"
              className="theme-toggle tap-target-comfortable"
              aria-label="Toggle theme"
              aria-pressed={theme === 'light'}
              title="Toggle theme"
              onClick={toggle}
            >
              <Sun aria-hidden="true" className="theme-icon sun" />
              <Moon aria-hidden="true" className="theme-icon moon" />
            </button>
          </ProductBarPortal>
          <div className="landing-hero-copy">
            <h2 id="landing-title">Analyze a Spark event log.</h2>
            <p>
              Load the log from one Spark run. You get a verdict on how it went, the stages worth fixing first, and the
              evidence behind each suggestion.
            </p>
          </div>
          <div className="landing-proof" aria-label="SparkForensics guarantees">
            <span><ShieldCheck aria-hidden="true" /> Nothing leaves your machine</span>
            <span><Bot aria-hidden="true" /> Bring your AI into the investigation</span>
            <span><GitCompareArrows aria-hidden="true" /> Compare one run against another</span>
          </div>
          {/* The intake sits in the hero, not in a section of its own below
              it: a first-time visitor's only job here is loading a log, so
              Choose file and Try a sample run must be in the first viewport. */}
          <div className="landing-intake">
            {errorMessage ? <FileLoadAlert message={errorMessage} nonce={errorNonce} /> : null}
            <DropZone />
          </div>
        </section>

        <ResourceLinks />

        <NextStepsRail onCompare={() => setCompareMode(true)} />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="font-heading text-lg font-semibold">Compare two runs</h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="tap-target-comfortable"
          onClick={() => {
            // Opened from a run's dashboard: Cancel goes back to it.
            if (seededRunKept) {
              store.getState().setCompareSeed(null);
              drillIntoRun(seed.id);
              return;
            }
            setCompareMode(false);
            setA(null);
            setB(null);
          }}
        >
          {seededRunKept ? 'Back to the run' : 'Cancel'}
        </Button>
      </div>
      <p className="landing-compare-intro">
        {seededRunKept
          ? 'Run A is the run you had open. Pick the run to compare it with, for example the same job after a change, as Run B.'
          : 'Use Run A as the baseline and Run B as the candidate. Compare structurally matched stages to review material changes in a shared stage-level context.'}
      </p>
      {errorMessage ? <FileLoadAlert message={errorMessage} nonce={errorNonce} /> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <p className="mb-2 text-sm font-medium text-muted-foreground">Run A (baseline)</p>
          <Slot testId="compare-slot-a" ariaLabel="Run A" source={a} onPick={setA} onChange={() => { store.getState().setCompareSeed(null); setA(null); }} />
        </div>
        <div>
          <p className="mb-2 text-sm font-medium text-muted-foreground">Run B (candidate)</p>
          <Slot testId="compare-slot-b" ariaLabel="Run B" source={b} onPick={setB} onChange={() => setB(null)} />
        </div>
      </div>
      <div className="flex justify-end">
        <Button type="button" className="tap-target-comfortable" disabled={!a || !b} onClick={() => { if (a && b) startCompareLoad(a, b); }}>
          Compare
        </Button>
      </div>
    </div>
  );
}
