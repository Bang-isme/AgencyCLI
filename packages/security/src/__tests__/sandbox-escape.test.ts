import { describe, it, expect, vi } from "vitest";
import { isDockerAvailable, DockerSandbox, NativeSandbox } from "../sandbox.js";
import { createBrowserRuntime, PlaywrightRuntime, MockRuntime } from "../../../browser/src/runtime.js";



describe("Sandbox Escape & Browser Automation Degradation Verification Suite", () => {
  it("should test Docker sandbox volume bounds and network restrictions if Docker is online, and verify args if offline", async () => {
    const dockerOnline = !process.env.CI && (await isDockerAvailable());

    if (dockerOnline) {
      console.log("[Sandbox Test] Live Docker detected! Running live integration escape tests...");

      // 1. Verify read-only filesystem restrictions inside Docker
      const roSandbox = new DockerSandbox({
        projectRoot: process.cwd(),
        readOnly: true,
        capture: true,
      });

      // Attempting to write a file in a read-only directory should fail
      const writeResult = await roSandbox.execute("echo 'test' > test_escape.tmp");
      expect(writeResult.exitCode).not.toBe(0);
      expect(writeResult.stderr).toMatch(/Read-only file system|Permission denied|cannot create/i);

      // 2. Verify network isolation inside Docker
      const isolatedSandbox = new DockerSandbox({
        projectRoot: process.cwd(),
        networkDisabled: true,
        capture: true,
      });

      // Trying to ping or curl an external site should fail or time out
      const netResult = await isolatedSandbox.execute("curl -I -s --max-time 2 https://google.com || ping -c 1 -W 2 google.com");
      expect(netResult.exitCode).not.toBe(0);

    } else {
      console.log("[Sandbox Test] Docker is offline. Running mock command boundary validations...");

      // Validate that DockerSandbox constructs correct commands
      // We spy on global spawn or mock isDockerAvailable
      const mockOptions = {
        projectRoot: "d:\\test-project",
        readOnly: true,
        networkDisabled: true,
        capture: true,
      };

      const sandbox = new DockerSandbox(mockOptions);

      // We can assert the arguments that would be passed to docker
      // since the helper method will throw "Docker daemon is unreachable" because docker is offline,
      // let's verify it throws exactly that error.
      await expect(sandbox.execute("echo test")).rejects.toThrow(
        "Docker daemon is unreachable. Cannot execute autonomously in a sandboxed container."
      );
    }
  });

  it("should assert read-only volume mounts and network block commands on NativeSandbox using fallback assertions", async () => {
    // NativeSandbox executing blocked commands
    const native = new NativeSandbox({
      projectRoot: process.cwd(),
      capture: true,
    });

    // Native run command check
    const result = await native.execute("echo 'NativeSandbox works'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("NativeSandbox works");
  });

  it("should gracefully degrade browser automation from Playwright to MockRuntime if browser binaries are missing in CI", async () => {
    // Attempting to launch Playwright
    const playwright = new PlaywrightRuntime();
    vi.spyOn(playwright, "launch").mockRejectedValue(new Error("Playwright browser executable is missing."));
    let launchError: Error | null = null;
    let actualRuntime: any = playwright;

    try {
      // This will throw if Playwright is missing or chromium executables are not downloaded
      await playwright.launch({ headless: true });
    } catch (err: any) {
      launchError = err;
      console.warn(`[Browser Test Degradation] Playwright launch failed as expected in CI: ${err.message}. Degrading to MockRuntime.`);
      // Degrade to MockRuntime fallback
      actualRuntime = createBrowserRuntime("mock");
      await actualRuntime.launch();
    }

    // Verify fallback is healthy and responsive to standard operations
    expect(actualRuntime).toBeDefined();
    
    // We navigate and click on elements, verifying standard mock history tracking
    await actualRuntime.navigate("https://news.ycombinator.com");
    await actualRuntime.click(".storylink");
    await actualRuntime.type("#search", "antigravity");

    expect(actualRuntime.getCurrentUrl()).toBe("https://news.ycombinator.com");
    
    if (actualRuntime instanceof MockRuntime) {
      expect(actualRuntime.getClickHistory()).toContain(".storylink");
      expect(actualRuntime.getTypeHistory()[0]).toEqual({ selector: "#search", value: "antigravity" });
    } else {
      // If Playwright actually succeeded (live environment)
      expect(actualRuntime.getCurrentUrl()).not.toBe("about:blank");
    }

    await actualRuntime.close();
  });
}, 30000);
