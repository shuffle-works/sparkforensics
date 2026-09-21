import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export interface StageDetailContextValue {
  /** Stage currently pinned open in the detail dialog, or null when closed. */
  stageId: number | null;
  openStage: (stageId: number) => void;
  close: () => void;
}

const Ctx = createContext<StageDetailContextValue | null>(null);

/** Owns which stage's detail dialog is open: consumers call
 * `useStageDetail().openStage(id)`. Mount the actual dialog once, inside this
 * provider, reading `stageId` to know what to render. */
export function StageDetailProvider({ children }: { children: ReactNode }) {
  const [stageId, setStageId] = useState<number | null>(null);

  const openStage = useCallback((id: number) => setStageId(id), []);
  const close = useCallback(() => setStageId(null), []);

  const value = useMemo<StageDetailContextValue>(
    () => ({ stageId, openStage, close }),
    [stageId, openStage, close],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStageDetail(): StageDetailContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStageDetail outside StageDetailProvider');
  return v;
}
