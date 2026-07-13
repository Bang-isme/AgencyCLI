import { useSyncExternalStore, useCallback } from "react";
import { animationsEnabled } from "./animations.js";
import { getFrame, subscribeFrame } from "./frameClock.js";

/**
 * Incrementing frame counter for terminal animations.
 *
 * All animated components share a single adaptive frame clock (see
 * {@link ./frameClock}) instead of each spinning up its own `setInterval`.
 * When `active` is false or animations are disabled, this is inert and returns
 * a constant `0`, so static rendering never subscribes or re-renders.
 */
export function useTick(active: boolean, intervalMs = 90): number {
  const motion = animationsEnabled();
  const live = active && motion;

  const subscribe = useCallback(
    (onChange: () => void) => (live ? subscribeFrame(intervalMs, onChange) : () => {}),
    [live, intervalMs]
  );

  const getSnapshot = useCallback(
    () => (live ? getFrame(intervalMs) : 0),
    [live, intervalMs]
  );

  const tick = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => 0
  );

  return live ? tick : 0;
}
