import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from "react";

/**
 * Progressive disclosure view levels:
 * - default: calm spinner updates, high-signal only
 * - advanced: adds active DAG graphs and telemetry counts
 * - expert: adds scheduler details and transaction WAL replay hashes
 */
export type DisclosureLevel = "default" | "advanced" | "expert";

const LEVELS: DisclosureLevel[] = ["default", "advanced", "expert"];

interface DisclosureContextValue {
  level: DisclosureLevel;
  cycle: () => void;
  setLevel: (level: DisclosureLevel) => void;
  isAtLeast: (minLevel: DisclosureLevel) => boolean;
}

const DisclosureContext = createContext<DisclosureContextValue>({
  level: "default",
  cycle: () => {},
  setLevel: () => {},
  isAtLeast: () => true,
});

/**
 * Manages progressive disclosure state across the TUI.
 * Ctrl+D cycles: Default → Advanced → Expert → Default.
 */
export function DisclosureProvider({ children }: { children: ReactNode }) {
  const [level, setLevel] = useState<DisclosureLevel>("default");

  const cycle = useCallback(() => {
    setLevel((current) => {
      const idx = LEVELS.indexOf(current);
      return LEVELS[(idx + 1) % LEVELS.length]!;
    });
  }, []);

  const isAtLeast = useCallback(
    (minLevel: DisclosureLevel) => {
      return LEVELS.indexOf(level) >= LEVELS.indexOf(minLevel);
    },
    [level]
  );

  return (
    <DisclosureContext.Provider value={{ level, cycle, setLevel, isAtLeast }}>
      {children}
    </DisclosureContext.Provider>
  );
}

/** Access the current disclosure level and toggle function. */
export function useDisclosure(): DisclosureContextValue {
  return useContext(DisclosureContext);
}
