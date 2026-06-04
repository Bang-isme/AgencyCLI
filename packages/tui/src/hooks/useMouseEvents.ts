import { useEffect, useRef } from "react";
import { subscribeMouse, mouseEnabled, type TuiMouseEvent } from "../terminal/mouse.js";

/**
 * Subscribe a component to terminal mouse events (flag `mouseSupport`). The
 * handler is held in a ref so it can close over fresh state every render without
 * re-subscribing each time. When the mouse layer is off (or `active` is false)
 * this is inert — no subscription, no work.
 */
export function useMouseEvents(
  handler: (ev: TuiMouseEvent) => void,
  active = true
): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    if (!active || !mouseEnabled()) return;
    return subscribeMouse((ev) => ref.current(ev));
  }, [active]);
}
