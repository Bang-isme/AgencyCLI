import { describe, it, expect } from "vitest";
import { EgressFilterProxy } from "../egress-proxy.js";

describe("🛡️ EgressFilterProxy - Active Bypass Guard Integration Checks", () => {
  const root = process.cwd();
  const proxy = new EgressFilterProxy({ projectRoot: root });
  const isAllowed = (proxy as any).isAllowed.bind(proxy);

  it("✅ should allow whitelisted LLM and core developer domains", () => {
    expect(isAllowed("api.openai.com")).toBe(true);
    expect(isAllowed("api.anthropic.com")).toBe(true);
    expect(isAllowed("127.0.0.1")).toBe(true);
  });

  it("✅ should successfully block malicious / non-whitelisted domains", () => {
    expect(isAllowed("attacker-server.com")).toBe(false);
    expect(isAllowed("malicious-domain.net")).toBe(false);
    expect(isAllowed("google.com")).toBe(false); // Not allowed by default whitelists
  });

  it("✅ should strictly block raw IP connections to prevent SNI proxy bypass", () => {
    expect(isAllowed("185.199.108.153")).toBe(false);
  });
});
