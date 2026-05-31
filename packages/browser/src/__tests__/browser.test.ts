import { describe, expect, it } from "vitest";
import { createBrowserRuntime, MockRuntime, PlaywrightRuntime, CdpRuntime } from "../runtime.js";

describe("packages/browser", () => {
  describe("createBrowserRuntime", () => {
    it("should instantiate correct runtimes based on factory mode", () => {
      const mock = createBrowserRuntime("mock");
      expect(mock).toBeInstanceOf(MockRuntime);
      expect(mock.getMode()).toBe("mock");

      const playwright = createBrowserRuntime("playwright");
      expect(playwright).toBeInstanceOf(PlaywrightRuntime);
      expect(playwright.getMode()).toBe("playwright");

      const cdp = createBrowserRuntime("cdp");
      expect(cdp).toBeInstanceOf(CdpRuntime);
      expect(cdp.getMode()).toBe("cdp");
    });
  });

  describe("MockRuntime", () => {
    it("should operate statefully and track interactions", async () => {
      const mock = new MockRuntime();
      expect(mock.getCurrentUrl()).toBe("about:blank");

      // Actions prior to launch should fail
      await expect(mock.navigate("https://google.com")).rejects.toThrow("Mock browser is not launched.");

      await mock.launch();
      await mock.navigate("https://google.com");
      expect(mock.getCurrentUrl()).toBe("https://google.com");

      // Verify clicks are tracked
      await mock.click("#login-btn");
      await mock.click(".submit");
      expect(mock.getClickHistory()).toEqual(["#login-btn", ".submit"]);

      // Verify typing is tracked
      await mock.type("#username", "john_doe");
      expect(mock.getTypeHistory()).toEqual([{ selector: "#username", value: "john_doe" }]);

      // Verify screenshot buffer
      const shot = await mock.screenshot();
      expect(shot.toString()).toBe("mock-screenshot-bytes");

      // Verify evaluation
      const title = await mock.evaluate<string>("document.title");
      expect(title).toBe("Mock Page Title");

      const empty = await mock.evaluate<any>("1 + 1");
      expect(empty).toEqual({});

      await mock.close();
      // Actions after close should fail
      await expect(mock.navigate("https://google.com")).rejects.toThrow("Mock browser is not launched.");
    });
  });

  describe("PlaywrightRuntime Out-of-the-Box Safe Fallback", () => {
    it("should throw a friendly helpful error if playwright package or executables are missing", async () => {
      const playwright = new PlaywrightRuntime();
      await expect(playwright.launch({ browserName: "chromium" })).rejects.toThrow(
        /Playwright.*(not installed|missing)/
      );
    });
  });

  describe("CdpRuntime Edge Cases", () => {
    it("should throw if cdpUrl is not provided", async () => {
      const cdp = new CdpRuntime();
      await expect(cdp.launch()).rejects.toThrow(/cdpUrl is required/);
    });

    it("should fail gracefully on invalid connection URL", async () => {
      const cdp = new CdpRuntime();
      // Try to launch with an invalid ws URL
      await expect(cdp.launch({ cdpUrl: "ws://127.0.0.1:9999/invalid-socket" })).rejects.toThrow(
        /CDP connection failed/
      );
    });
  });
});
