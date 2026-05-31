import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export interface HeartbeatEntry {
  /** Operational message (e.g. "Resolving auth graph...") */
  message: string;
  /** Timestamp of the heartbeat */
  timestamp: number;
}

interface HeartbeatContextValue {
  /** Latest heartbeat message */
  current: HeartbeatEntry | null;
  /** Emit a new heartbeat (called by workers/orchestrator) */
  emit: (message: string) => void;
  /** Whether the runtime has been silent too long */
  isSilent: boolean;
  /** Time in ms since last meaningful update */
  silenceDuration: number;
}

const HeartbeatContext = createContext<HeartbeatContextValue>({
  current: null,
  emit: () => {},
  isSilent: false,
  silenceDuration: 0,
});

/**
 * Maximum duration (ms) before the runtime is considered "silent".
 * After this threshold, heartbeat indicators activate to preserve momentum.
 */
const MAX_SILENT_DURATION_MS = 3000;

/** Check interval for silence detection */
const CHECK_INTERVAL_MS = 1000;

/**
 * HeartbeatProvider manages the global silence budget.
 *
 * If no meaningful updates occur within MAX_SILENT_DURATION_MS,
 * the `isSilent` flag activates — allowing UI components to show
 * subtle heartbeat indicators to preserve execution momentum feel.
 */
export function HeartbeatProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<HeartbeatEntry | null>(null);
  const [isSilent, setIsSilent] = useState(false);
  const [silenceDuration, setSilenceDuration] = useState(0);
  const lastEmitRef = useRef<number>(Date.now());

  const emit = useCallback((message: string) => {
    const now = Date.now();
    lastEmitRef.current = now;
    setCurrent({ message, timestamp: now });
    setIsSilent(false);
    setSilenceDuration(0);
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      const elapsed = Date.now() - lastEmitRef.current;
      setSilenceDuration(elapsed);
      if (elapsed >= MAX_SILENT_DURATION_MS) {
        setIsSilent(true);
      }
    }, CHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, []);

  return (
    <HeartbeatContext.Provider value={{ current, emit, isSilent, silenceDuration }}>
      {children}
    </HeartbeatContext.Provider>
  );
}

/** Access global heartbeat state and emit function. */
export function useHeartbeat(): HeartbeatContextValue {
  return useContext(HeartbeatContext);
}
