import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useStdout } from "ink";
import { measureTerminal, type TerminalLayout } from "./terminal-layout.js";

const TerminalLayoutContext = createContext<TerminalLayout>(measureTerminal());

const COLS_BUMP_MS = 120;

function readLayout(stdout: NodeJS.WriteStream | undefined): TerminalLayout {
  return measureTerminal(stdout?.columns ?? 80, stdout?.rows ?? 24);
}

export function TerminalLayoutProvider({ children }: { children: ReactNode }) {
  const { stdout } = useStdout();
  const [layout, setLayout] = useState(() => readLayout(stdout));
  const stableColsRef = useRef(layout.cols);
  const bumpTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    const apply = (next: TerminalLayout) => {
      setLayout((prev) => {
        if (
          prev.cols === next.cols &&
          prev.rows === next.rows &&
          prev.shellWidth === next.shellWidth &&
          prev.contentWidth === next.contentWidth &&
          prev.composerWidth === next.composerWidth
        ) {
          return prev;
        }
        return next;
      });
    };

    const sync = (isResizeEvent = false) => {
      const rawCols = stdout?.columns ?? 80;
      const rawRows = stdout?.rows ?? 24;

      if (!isResizeEvent) {
        stableColsRef.current = rawCols;
        apply(measureTerminal(rawCols, rawRows));
        return;
      }

      // Debounce all resize updates to eliminate scrollbar flashing loops
      clearTimeout(bumpTimerRef.current);
      bumpTimerRef.current = setTimeout(() => {
        stableColsRef.current = rawCols;
        apply(measureTerminal(rawCols, rawRows));
      }, COLS_BUMP_MS);
    };

    sync(false);
    const onResize = () => sync(true);
    stdout?.on("resize", onResize);
    return () => {
      stdout?.off("resize", onResize);
      clearTimeout(bumpTimerRef.current);
    };
  }, [stdout]);

  return (
    <TerminalLayoutContext.Provider value={layout}>
      {children}
    </TerminalLayoutContext.Provider>
  );
}

/** Layout dimensions synced on terminal resize (fullscreen / drag). */
export function useTerminalLayout(): TerminalLayout {
  return useContext(TerminalLayoutContext);
}
