import type { BrowserAutomationRuntime, BrowserLaunchOptions, BrowserMode } from "./types.js";

const activePlaywrightRuntimes = new Set<PlaywrightRuntime>();
let playwrightCleanupRegistered = false;

function registerPlaywrightCleanup() {
  if (playwrightCleanupRegistered) return;
  playwrightCleanupRegistered = true;

  const killAll = async () => {
    await Promise.all(
      Array.from(activePlaywrightRuntimes).map(async (runtime) => {
        try {
          await runtime.close();
        } catch {}
      })
    );
    activePlaywrightRuntimes.clear();
  };

  process.on("SIGINT", async () => {
    await killAll();
    if (process.env.AGENCY_TUI !== "true") {
      process.exit(130);
    }
  });

  process.on("SIGTERM", async () => {
    await killAll();
    if (process.env.AGENCY_TUI !== "true") {
      process.exit(143);
    }
  });
}

/**
 * Stateful Mock Browser Engine for testing, sandboxes, and zero-dependency CI runs.
 */
export class MockRuntime implements BrowserAutomationRuntime {
  private currentUrl = "about:blank";
  private clickHistory: string[] = [];
  private typeHistory: { selector: string; value: string }[] = [];
  private launched = false;

  getMode(): BrowserMode {
    return "mock";
  }

  getCurrentUrl(): string {
    return this.currentUrl;
  }

  async launch(_options?: BrowserLaunchOptions): Promise<void> {
    this.launched = true;
  }

  async navigate(url: string): Promise<void> {
    if (!this.launched) throw new Error("Mock browser is not launched.");
    this.currentUrl = url;
  }

  async click(selector: string): Promise<void> {
    if (!this.launched) throw new Error("Mock browser is not launched.");
    this.clickHistory.push(selector);
  }

  async type(selector: string, value: string): Promise<void> {
    if (!this.launched) throw new Error("Mock browser is not launched.");
    this.typeHistory.push({ selector, value });
  }

  async screenshot(): Promise<Buffer> {
    if (!this.launched) throw new Error("Mock browser is not launched.");
    return Buffer.from("mock-screenshot-bytes");
  }

  async evaluate<T>(script: string): Promise<T> {
    if (!this.launched) throw new Error("Mock browser is not launched.");
    if (script.includes("document.title")) {
      return "Mock Page Title" as unknown as T;
    }
    return {} as T;
  }

  async close(): Promise<void> {
    this.launched = false;
  }

  getClickHistory(): string[] {
    return this.clickHistory;
  }

  getTypeHistory(): { selector: string; value: string }[] {
    return this.typeHistory;
  }
}

/**
 * Playwright Browser Engine using dynamic imports to avoid heavy mandatory dependencies.
 */
export class PlaywrightRuntime implements BrowserAutomationRuntime {
  private browser: any = null;
  private context: any = null;
  private page: any = null;
  private currentUrl = "about:blank";

  getMode(): BrowserMode {
    return "playwright";
  }

  getCurrentUrl(): string {
    if (this.page) {
      try {
        return this.page.url();
      } catch {
        return this.currentUrl;
      }
    }
    return this.currentUrl;
  }

  async launch(options?: BrowserLaunchOptions): Promise<void> {
    registerPlaywrightCleanup();
    activePlaywrightRuntimes.add(this);

    let playwrightModule: any;
    try {
      playwrightModule = await import("playwright");
    } catch {
      throw new Error(
        "Playwright is not installed in the workspace.\n" +
        "To run browser automation via Playwright, please install it first:\n" +
        "  pnpm add -D playwright\n" +
        "  npx playwright install chromium"
      );
    }

    const browserName = options?.browserName ?? "chromium";
    const headless = options?.headless ?? true;

    const launcher = playwrightModule[browserName];
    if (!launcher) {
      throw new Error(`Unsupported Playwright browser engine: ${browserName}`);
    }

    try {
      this.browser = await launcher.launch({ headless });
      this.context = await this.browser.newContext();
      this.page = await this.context.newPage();
    } catch (err: any) {
      if (
        err.message?.includes("Executable doesn't exist") ||
        err.message?.includes("playwright install") ||
        err.message?.includes("download new browsers")
      ) {
        throw new Error(
          `Playwright browser executable is missing.\n` +
          `Please download the required browser binaries by running:\n` +
          `  npx playwright install ${browserName}`
        );
      }
      throw err;
    }
  }

  async navigate(url: string): Promise<void> {
    if (!this.page) throw new Error("Playwright browser is not launched.");
    await this.page.goto(url);
    this.currentUrl = url;
  }

  async click(selector: string): Promise<void> {
    if (!this.page) throw new Error("Playwright browser is not launched.");
    await this.page.click(selector);
  }

  async type(selector: string, value: string): Promise<void> {
    if (!this.page) throw new Error("Playwright browser is not launched.");
    await this.page.fill(selector, value);
  }

  async screenshot(): Promise<Buffer> {
    if (!this.page) throw new Error("Playwright browser is not launched.");
    return await this.page.screenshot();
  }

  async evaluate<T>(script: string): Promise<T> {
    if (!this.page) throw new Error("Playwright browser is not launched.");
    return await this.page.evaluate(script);
  }

  async close(): Promise<void> {
    activePlaywrightRuntimes.delete(this);
    if (this.browser) {
      await this.browser.close();
    }
    this.page = null;
    this.context = null;
    this.browser = null;
  }
}

/**
 * Chrome DevTools Protocol (CDP) Browser Engine using native WebSockets (zero-dependency).
 */
export class CdpRuntime implements BrowserAutomationRuntime {
  private ws: WebSocket | null = null;
  private idCounter = 1;
  private currentUrl = "about:blank";
  private cdpUrl = "";

  getMode(): BrowserMode {
    return "cdp";
  }

  getCurrentUrl(): string {
    return this.currentUrl;
  }

  async launch(options?: BrowserLaunchOptions): Promise<void> {
    if (!options?.cdpUrl) {
      throw new Error("cdpUrl is required when launching Browser Automation in CDP mode.");
    }
    this.cdpUrl = options.cdpUrl;
    
    return new Promise((resolve, reject) => {
      try {
        const ws = new globalThis.WebSocket(this.cdpUrl);
        ws.onopen = () => {
          this.ws = ws;
          resolve();
        };
        ws.onerror = () => {
          reject(new Error(`CDP connection failed to URL: ${this.cdpUrl}`));
        };
      } catch (err: any) {
        reject(new Error(`Failed to instantiate WebSocket to CDP URL: ${err.message}`));
      }
    });
  }

  private sendCommand(method: string, params: Record<string, any> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws) {
        return reject(new Error("CDP browser is not launched."));
      }
      const id = this.idCounter++;
      const payload = JSON.stringify({ id, method, params });
      
      const onMessage = (event: MessageEvent) => {
        try {
          const res = JSON.parse(event.data);
          if (res.id === id) {
            this.ws!.removeEventListener("message", onMessage);
            if (res.error) {
              reject(new Error(`CDP command ${method} failed: ${res.error.message}`));
            } else {
              resolve(res.result);
            }
          }
        } catch {
          // ignore parsing errors
        }
      };

      this.ws.addEventListener("message", onMessage);
      this.ws.send(payload);
    });
  }

  async navigate(url: string): Promise<void> {
    await this.sendCommand("Page.navigate", { url });
    this.currentUrl = url;
  }

  async click(selector: string): Promise<void> {
    // Robustly trigger clicks inside context via evaluation scripts
    const script = `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error("Element not found: " + ${JSON.stringify(selector)});
        el.click();
        return true;
      })()
    `;
    await this.evaluate(script);
  }

  async type(selector: string, value: string): Promise<void> {
    const script = `
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error("Element not found: " + ${JSON.stringify(selector)});
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          el.value = ${JSON.stringify(value)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          el.textContent = ${JSON.stringify(value)};
        }
        return true;
      })()
    `;
    await this.evaluate(script);
  }

  async screenshot(): Promise<Buffer> {
    const result = await this.sendCommand("Page.captureScreenshot", { format: "png" });
    if (!result?.data) {
      throw new Error("CDP failed to capture viewport screenshot.");
    }
    return Buffer.from(result.data, "base64");
  }

  async evaluate<T>(script: string): Promise<T> {
    const result = await this.sendCommand("Runtime.evaluate", {
      expression: script,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result?.exceptionDetails) {
      throw new Error(`CDP Evaluation Exception: ${result.exceptionDetails.exception?.description || "Evaluation failed"}`);
    }
    return result?.result?.value as T;
  }

  async close(): Promise<void> {
    if (this.ws) {
      this.ws.close();
    }
    this.ws = null;
  }
}

/**
 * Factory builder supporting modular construction of browser runtimes.
 */
export function createBrowserRuntime(mode: BrowserMode = "mock"): BrowserAutomationRuntime {
  switch (mode) {
    case "playwright":
      return new PlaywrightRuntime();
    case "cdp":
      return new CdpRuntime();
    case "mock":
    default:
      return new MockRuntime();
  }
}
