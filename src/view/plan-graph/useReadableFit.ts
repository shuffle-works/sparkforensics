import { useCallback } from 'react';
import { useReactFlow, useStoreApi } from '@xyflow/react';
import { boundsOf, readableViewport } from './readable-fit';

/** Returns a function that fits the whole graph at a readable zoom (see
 * `readableViewport`). It reports whether a fit happened, so a caller can retry
 * once the canvas has been measured. Must sit under the React Flow provider. */
export function useReadableFit() {
  const { getNodes, setViewport } = useReactFlow();
  const store = useStoreApi();
  return useCallback(
    (duration = 0): boolean => {
      const { width, height } = store.getState();
      const bounds = boundsOf(
        getNodes().map((n) => ({
          x: n.position.x,
          y: n.position.y,
          width: n.measured?.width ?? n.width ?? 0,
          height: n.measured?.height ?? n.height ?? 0,
        })),
      );
      if (!width || !height || !bounds) return false;
      void setViewport(readableViewport(bounds, { width, height }), { duration });
      return true;
    },
    [getNodes, setViewport, store],
  );
}
