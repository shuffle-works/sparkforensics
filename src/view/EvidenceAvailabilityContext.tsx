import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { EvidenceKey } from '@sparkforensics/core/types.ts';

export const EVIDENCE_LABELS: Record<EvidenceKey, string> = {
  executorMetrics: 'Executor metrics',
  rddStorageSnapshots: 'RDD storage snapshots',
  sqlPlan: 'SQL plan',
  sparkConfiguration: 'Spark configuration',
  taskCoreTime: 'Task and core time',
  infrastructureContext: 'Infrastructure context',
  sourceContext: 'Source context',
  costContext: 'Cost context',
};

export function evidenceLabel(key: EvidenceKey): string {
  return EVIDENCE_LABELS[key];
}

interface EvidenceAvailabilityContextValue {
  referenceOpen: boolean;
  setReferenceOpen: (open: boolean) => void;
  evidenceCardOpen: boolean;
  setEvidenceCardOpen: (open: boolean) => void;
  revealEvidence: (key: EvidenceKey) => void;
  /** Callback-ref registry of the ledger rows, keyed by evidence key. Focus
   * targets the live element instead of a `getElementById` id lookup, so
   * rows that render after the accordion/card opens are still reachable. */
  registerRow: (key: EvidenceKey, el: HTMLElement | null) => void;
}

const DEFAULT_CONTEXT: EvidenceAvailabilityContextValue = {
  referenceOpen: false,
  setReferenceOpen: () => {},
  evidenceCardOpen: true,
  setEvidenceCardOpen: () => {},
  revealEvidence: () => {},
  registerRow: () => {},
};

export const EvidenceAvailabilityContext = createContext<EvidenceAvailabilityContextValue | null>(null);

/** Coordinates the two nested disclosures that lead to a ledger row. The
 * pending focus is deliberately local UI state: evidence availability remains
 * model data, not a Zustand field or detector finding. */
export function EvidenceAvailabilityProvider({ children }: { children: ReactNode }) {
  const [referenceOpen, setReferenceOpen] = useState(false);
  // Starts collapsed so the ledger sits as a uniform tile in the Reference
  // grid; `revealEvidence` (evidence links across the app) re-opens it.
  const [evidenceCardOpen, setEvidenceCardOpen] = useState(false);
  const pendingFocus = useRef<EvidenceKey | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const rowRefs = useRef(new Map<EvidenceKey, HTMLElement>());

  const registerRow = useCallback((key: EvidenceKey, el: HTMLElement | null) => {
    if (el) rowRefs.current.set(key, el);
    else rowRefs.current.delete(key);
  }, []);

  const revealEvidence = useCallback((key: EvidenceKey) => {
    pendingFocus.current = key;
    setReferenceOpen(true);
    setEvidenceCardOpen(true);
    setFocusRequest((request) => request + 1);
  }, []);

  useLayoutEffect(() => {
    const key = pendingFocus.current;
    if (!key || focusRequest === 0) return;

    queueMicrotask(() => {
      rowRefs.current.get(key)?.focus();
    });
  }, [focusRequest]);

  const value = useMemo<EvidenceAvailabilityContextValue>(
    () => ({ referenceOpen, setReferenceOpen, evidenceCardOpen, setEvidenceCardOpen, revealEvidence, registerRow }),
    [referenceOpen, evidenceCardOpen, revealEvidence, registerRow],
  );

  return <EvidenceAvailabilityContext.Provider value={value}>{children}</EvidenceAvailabilityContext.Provider>;
}

function useEvidenceAvailabilityContext(): EvidenceAvailabilityContextValue {
  return useContext(EvidenceAvailabilityContext) ?? DEFAULT_CONTEXT;
}

export function useEvidenceAvailabilityNavigation(): { revealEvidence: (key: EvidenceKey) => void } {
  const { revealEvidence } = useEvidenceAvailabilityContext();
  return { revealEvidence };
}

/** Internal disclosure state consumed by the Reference accordion and ledger
 * card. The public navigation hook intentionally exposes only `revealEvidence`.
 */
export function useEvidenceAvailabilityDisclosure() {
  const { referenceOpen, setReferenceOpen, evidenceCardOpen, setEvidenceCardOpen } = useEvidenceAvailabilityContext();
  return { referenceOpen, setReferenceOpen, evidenceCardOpen, setEvidenceCardOpen };
}

/** Row registration for ledger entries: the ledger card calls this with a
 * callback ref per key so programmatic focus targets the live element.
 */
export function useEvidenceRowRegistration() {
  const { registerRow } = useEvidenceAvailabilityContext();
  return registerRow;
}
