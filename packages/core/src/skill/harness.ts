export type SkillHarnessMode = "default" | "long-reasoning" | "long-runner";

export interface HarnessOptions {
  mode: SkillHarnessMode;
  maxTurns?: number;
  checkpointEvery?: number;
  hintSkills?: string[];
}

const LONG_REASONING_HINT = ["codex-reasoning-rigor"];
const LONG_RUNNER_HINT = ["codex-subagent-execution"];

export function getHarnessConfig(mode: SkillHarnessMode): HarnessOptions {
  switch (mode) {
    case "long-reasoning":
      return {
        mode,
        maxTurns: 40,
        hintSkills: LONG_REASONING_HINT,
      };
    case "long-runner":
      return {
        mode,
        checkpointEvery: 1,
        hintSkills: LONG_RUNNER_HINT,
      };
    default:
      return { mode };
  }
}

export function inferHarnessMode(skillName: string): SkillHarnessMode {
  if (skillName === "codex-subagent-execution") {
    return "long-runner";
  }
  if (skillName === "codex-reasoning-rigor") {
    return "long-reasoning";
  }
  return "default";
}

export function harnessModeHint(skillName: string): string {
  const mode = inferHarnessMode(skillName);
  const config = getHarnessConfig(mode);
  if (mode === "default") {
    return "harness: default";
  }
  const parts = [`harness: ${mode}`];
  if (config.maxTurns !== undefined) {
    parts.push(`maxTurns=${config.maxTurns}`);
  }
  if (config.checkpointEvery !== undefined) {
    parts.push(`checkpointEvery=${config.checkpointEvery}`);
  }
  if (config.hintSkills?.length) {
    parts.push(`hints=${config.hintSkills.join(",")}`);
  }
  return parts.join(" ");
}

