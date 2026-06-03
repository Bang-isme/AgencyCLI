import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listWorkflowNames, WORKFLOWS } from "@agency/core";
import {
  BUILTIN_SCRIPTS,
  loadPluginTools,
  skillMdPath,
  workflowSkillLoads,
} from "@agency/skills-bridge";

/**
 * Tight-coupling guard for the workflow composer ↔ bundled skills pack.
 *
 * `runWorkflow` executes each step by `join(skillsRoot, step.script)` and the
 * router/gate/task-runner reach the pack through `BUILTIN_SCRIPTS`. Those script
 * paths are plain strings declared in code, but the scripts they name live in the
 * pack (`packages/cli/skills`). Nothing asserted the two stayed in sync, so a
 * renamed or moved pack script would only surface as a non-zero exit at runtime
 * (a workflow step "failing" with no compile/test signal) — the initiative's
 * "machinery wired to a path that no longer exists" defect class. This test fails
 * loudly in `pnpm verify` the moment a referenced script goes missing.
 *
 * Reuses the real `WORKFLOWS` definition, the `BUILTIN_SCRIPTS` map, and the
 * `plugin-tools.json` contract (`loadPluginTools`) — the single sources of truth
 * the runtime/CLI resolve through — rather than re-listing paths. The plugin-tools
 * contract is the pack's external plugin-SDK tool set (Python maintenance/release/
 * memory scripts), distinct from the runtime ToolRegistry; checking it here catches
 * a renamed pack script without needing a Python interpreter in CI. Lives in
 * @agency/cli because it is the only package that both bundles the pack and sits
 * atop the dep graph (it can import `WORKFLOWS` from core).
 */

const PKG_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const SKILLS_ROOT = join(PKG_ROOT, "skills");

/** [label, relative script path] for every script the runtime resolves in the pack. */
function referencedScripts(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [workflow, steps] of Object.entries(WORKFLOWS)) {
    for (const step of steps) {
      out.push([`workflow ${workflow} › ${step.name}`, step.script]);
    }
  }
  for (const [name, rel] of Object.entries(BUILTIN_SCRIPTS)) {
    out.push([`builtin ${name}`, rel]);
  }
  for (const tool of loadPluginTools(SKILLS_ROOT).tools) {
    out.push([`plugin-tool ${tool.name}`, tool.script]);
  }
  return out;
}

describe("workflow composer ↔ pack script integrity", () => {
  it("every workflow step + builtin + plugin-tool script path exists in the bundled pack", () => {
    const missing = referencedScripts().filter(
      ([, rel]) => !existsSync(join(SKILLS_ROOT, rel))
    );
    // Surface the label + path of any drift, not just a bare boolean.
    expect(missing.map(([label, rel]) => `${label}: ${rel}`)).toEqual([]);
  });

  // The skill-chain side of the same coupling: each `.workflows/<name>.md` declares
  // `loads: [skill, …]`, which routeUserPrompt activates when that workflow is
  // selected (flag workflowSkillLoads). A workflow that names a skill the pack
  // doesn't ship would silently load nothing — the same "wired to a path that no
  // longer exists" defect, one layer up. Guard every declared load resolves to a
  // real SKILL.md so a renamed/removed skill fails here, not as a quiet no-op.
  it("every workflow's declared loads: skills resolve to a bundled SKILL.md", () => {
    const missing: string[] = [];
    for (const workflow of listWorkflowNames()) {
      const loads = workflowSkillLoads(SKILLS_ROOT, workflow);
      // Every code-defined workflow ships a `.workflows/<name>.md` declaring a
      // non-empty pipeline; an empty result means the file or its loads: drifted.
      if (loads.length === 0) {
        missing.push(`workflow ${workflow}: no loads: declared in .workflows/${workflow}.md`);
        continue;
      }
      for (const skill of loads) {
        if (!existsSync(skillMdPath(SKILLS_ROOT, skill))) {
          missing.push(`workflow ${workflow} loads ${skill}: no SKILL.md`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
