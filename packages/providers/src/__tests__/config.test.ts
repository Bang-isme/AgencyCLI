import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgencyConfig, resolveApiKey } from "../config.js";

describe("resolveApiKey", () => {
  const original = process.env.TEST_AGENCY_KEY;

  afterEach(() => {
    if (original === undefined) delete process.env.TEST_AGENCY_KEY;
    else process.env.TEST_AGENCY_KEY = original;
  });

  it("returns undefined when apiKey is missing", () => {
    expect(resolveApiKey({})).toBeUndefined();
  });

  it("expands ${ENV_VAR} placeholders from environment", () => {
    process.env.TEST_AGENCY_KEY = "secret-value";
    expect(resolveApiKey({ apiKey: "prefix-${TEST_AGENCY_KEY}-suffix" })).toBe(
      "prefix-secret-value-suffix"
    );
  });

  it("uses empty string for missing env vars", () => {
    delete process.env.MISSING_AGENCY_KEY;
    expect(resolveApiKey({ apiKey: "${MISSING_AGENCY_KEY}" })).toBe("");
  });
});

describe("loadAgencyConfig", () => {
  it("returns defaults when config file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-config-missing-"));
    try {
      const config = loadAgencyConfig(join(dir, "config.json"));
      expect(config.defaultProvider).toBe("anthropic");
      expect(config.providers).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads provider profiles from config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-config-load-"));
    const path = join(dir, "config.json");
    try {
      writeFileSync(
        path,
        JSON.stringify({
          defaultProvider: "openrouter",
          providers: {
            openrouter: { apiKey: "${OPENROUTER_API_KEY}", model: "anthropic/claude-3.5-sonnet" },
            local: { baseUrl: "http://127.0.0.1:8080/v1" },
          },
        })
      );
      const config = loadAgencyConfig(path);
      expect(config.defaultProvider).toBe("openrouter");
      expect(config.providers.openrouter?.model).toBe("anthropic/claude-3.5-sonnet");
      expect(config.providers.local?.baseUrl).toBe("http://127.0.0.1:8080/v1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps legacy default field to defaultProvider", () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-config-legacy-"));
    const path = join(dir, "config.json");
    try {
      writeFileSync(path, JSON.stringify({ default: "nvidia" }));
      const config = loadAgencyConfig(path);
      expect(config.defaultProvider).toBe("nvidia");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads thinking budget settings from config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-config-thinking-"));
    const path = join(dir, "config.json");
    try {
      writeFileSync(
        path,
        JSON.stringify({
          defaultProvider: "google",
          providers: {
            google: { apiKey: "test-key", model: "gemini-2.0-flash", thinking: 1024 },
            openai: { apiKey: "test-key", model: "o3-mini", thinking: "medium" },
          },
        })
      );
      const config = loadAgencyConfig(path);
      expect(config.providers.google?.thinking).toBe(1024);
      expect(config.providers.openai?.thinking).toBe("medium");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads custom/arbitrary providers from config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-config-custom-"));
    const path = join(dir, "config.json");
    try {
      writeFileSync(
        path,
        JSON.stringify({
          defaultProvider: "deepseek",
          providers: {
            deepseek: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-reasoner" },
          },
        })
      );
      const config = loadAgencyConfig(path);
      expect(config.defaultProvider).toBe("deepseek");
      expect(config.providers.deepseek?.baseUrl).toBe("https://api.deepseek.com/v1");
      expect(config.providers.deepseek?.model).toBe("deepseek-reasoner");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back on invalid config", () => {
    const dir = mkdtempSync(join(tmpdir(), "agency-config-invalid-"));
    const path = join(dir, "config.json");
    try {
      writeFileSync(path, "{ not-json");
      const config = loadAgencyConfig(path);
      expect(config.defaultProvider).toBe("anthropic");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
