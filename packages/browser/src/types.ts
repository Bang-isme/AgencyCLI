export type BrowserMode = "playwright" | "cdp" | "mock";

export interface BrowserLaunchOptions {
  /** The execution engine mode to use: "playwright", "cdp", or "mock". Defaults to "mock" for zero-dependency portability. */
  mode?: BrowserMode;
  /** Whether to launch the browser in headless mode. Defaults to true. */
  headless?: boolean;
  /** Chrome DevTools Protocol WebSocket URL (e.g. ws://localhost:9222/devtools/browser/...). Required in "cdp" mode. */
  cdpUrl?: string;
  /** For Playwright mode, the browser engine to launch. Defaults to "chromium". */
  browserName?: "chromium" | "firefox" | "webkit";
}

/**
 * Standard, decoupled interface for orchestrating autonomous browser automation tasks.
 */
export interface BrowserAutomationRuntime {
  /** Starts the browser session according to the configured mode. */
  launch(options?: BrowserLaunchOptions): Promise<void>;
  /** Directs the browser to load the specified URL. */
  navigate(url: string): Promise<void>;
  /** Simulates clicking a DOM node matching the target CSS selector. */
  click(selector: string): Promise<void>;
  /** Types text into a DOM node matching the target CSS selector. */
  type(selector: string, value: string): Promise<void>;
  /** Captures the current visible viewport screenshot as a binary buffer. */
  screenshot(): Promise<Buffer>;
  /** Executes a Javascript snippet in the page context. */
  evaluate<T>(script: string): Promise<T>;
  /** Shuts down the browser session and releases allocated resources. */
  close(): Promise<void>;
  /** Returns the current active page URL. */
  getCurrentUrl(): string;
  /** Returns the current operating mode. */
  getMode(): BrowserMode;
}
