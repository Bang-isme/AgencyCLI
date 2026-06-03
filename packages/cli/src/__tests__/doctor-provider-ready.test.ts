import { describe, expect, it } from "vitest";
import { providerIsReady } from "../commands/doctor.js";
import type { ProviderProfile } from "@agency/core";

/**
 * The "N ready" line in `agency doctor` must be honest: a provider counts as
 * ready only when it can actually be used. The key risk is a remote provider
 * that declares an `apiKey` it cannot resolve (an unset `${ENV}` placeholder)
 * yet also has a `baseUrl` — it would 401, so it must NOT be reported ready.
 */
describe("providerIsReady (honest doctor 'ready' predicate)", () => {
  const UNSET = "AGENCY_DOCTOR_UNSET_KEY_FIXTURE";
  delete process.env[UNSET];

  it("local is always ready (a self-hosted endpoint needs no credential)", () => {
    expect(providerIsReady("local", {})).toBe(true);
    expect(providerIsReady("local", { apiKey: `\${${UNSET}}` })).toBe(true);
  });

  it("a provider whose key resolves to a non-empty value is ready", () => {
    expect(providerIsReady("openrouter", { apiKey: "sk-real-key" })).toBe(true);
  });

  it("a keyless endpoint (no apiKey declared) reachable via baseUrl is ready", () => {
    expect(
      providerIsReady("ollama", { baseUrl: "http://localhost:11434/v1" })
    ).toBe(true);
  });

  it("a provider declaring an unresolvable ${ENV} key is NOT ready (no baseUrl)", () => {
    const p: ProviderProfile = { apiKey: `\${${UNSET}}` };
    expect(providerIsReady("anthropic", p)).toBe(false);
  });

  it("a provider declaring an unresolvable key is NOT ready even WITH a baseUrl (the fix)", () => {
    // Previously `|| Boolean(baseUrl)` marked this ready despite the missing key.
    const p: ProviderProfile = {
      apiKey: `\${${UNSET}}`,
      baseUrl: "https://api.remote.example/v1",
    };
    expect(providerIsReady("custom-remote", p)).toBe(false);
  });

  it("a provider with neither a resolvable key nor a baseUrl is NOT ready", () => {
    expect(providerIsReady("openai", {})).toBe(false);
  });
});
