import { runBuiltinScript } from "@agency/skills-bridge";
import { JSONRepairEngine } from "@agency/tooling";

export async function routePrompt(skillsRoot: string, prompt: string) {
  const { exitCode, stdout } = await runBuiltinScript(skillsRoot, "prompt_route", [
    "--prompt",
    prompt,
    "--format",
    "json",
  ]);
  if (exitCode !== 0) throw new Error(`prompt_router failed: ${stdout}`);
  try {
    const jre = new JSONRepairEngine();
    const repaired = jre.repair(stdout);
    return JSON.parse(repaired) as Record<string, unknown>;
  } catch {
    return JSON.parse(stdout) as Record<string, unknown>;
  }
}
