import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadManifestSkills } from "@agency/skills-bridge";
import { MANIFEST_AGENTS } from "../agents/types.js";
import { AGENT_SUBAGENT_PROMPT, AGENT_DISCIPLINES, subagentPromptPath } from "../agents/profiles.js";
import { capabilityRegistry } from "../agents/agent-registry.js";

/**
 * Structural-integrity guard for the agent dispatch space — the agent-layer
 * analog of `cli/__tests__/skills-manifest-integrity.test.ts`.
 *
 * `MANIFEST_AGENTS` is the real dispatch space, but three independent maps must
 * stay in lockstep with it or a dispatch silently degrades:
 *   - `AGENT_SUBAGENT_PROMPT` (profiles.ts): no entry ⇒ `subagentPromptPath`
 *     returns null ⇒ the subagent runs with no role prompt.
 *   - capability seeds (agent-registry.ts): no seed ⇒ the router treats the
 *     agent as "no-capability-signal" and can't rank/reroute it.
 *   - the referenced prompt file must actually exist under the bundled skills
 *     pack, else `subagentPromptPath` falls through to null.
 * Adding a 9th agent without all three is exactly the "built-but-unwired"
 * defect this initiative targets. This fails `pnpm verify` on any drift.
 *
 * Lives in @agency/core because every config map is core-local (no new public
 * export needed), and core already deps `@agency/skills-bridge` for the manifest
 * loader. The bundled skills pack is located by a deterministic relative path
 * (same approach as the cli integrity test) so it doesn't depend on env.
 */

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const SKILLS_ROOT = join(TEST_DIR, "../../../cli/skills");

const sorted = (xs: readonly string[]) => [...xs].sort();

describe("agent dispatch-space integrity", () => {
  it("locates the bundled skills pack (sanity)", () => {
    expect(existsSync(join(SKILLS_ROOT, ".system", "manifest.json"))).toBe(true);
  });

  it("every MANIFEST_AGENT has a subagent-prompt mapping (and no orphan mapping)", () => {
    expect(sorted(Object.keys(AGENT_SUBAGENT_PROMPT))).toEqual(sorted(MANIFEST_AGENTS));
  });

  it("every MANIFEST_AGENT has a capability seed (and no orphan seed)", () => {
    const seeded = capabilityRegistry.snapshot().map((d) => d.id);
    expect(sorted(seeded)).toEqual(sorted(MANIFEST_AGENTS));
  });

  it("every agent's mapped prompt template resolves to a real file on disk", () => {
    const missing = MANIFEST_AGENTS.filter(
      (agent) => !subagentPromptPath(SKILLS_ROOT, agent)
    );
    expect(missing).toEqual([]);
  });

  it("every discipline skill referenced by an agent is a declared manifest skill", () => {
    const declared = new Set(loadManifestSkills(SKILLS_ROOT));
    const referenced = [...new Set(Object.values(AGENT_DISCIPLINES).flat())].filter(
      (s): s is string => typeof s === "string"
    );
    const unknown = referenced.filter((s) => !declared.has(s));
    expect(unknown).toEqual([]);
  });
});
