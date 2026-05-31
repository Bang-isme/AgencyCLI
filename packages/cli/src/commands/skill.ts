import { Command } from "commander";
import {
  getHarnessConfig,
  getInvokeActions,
  getWorkspaceRoot,
  harnessModeHint,
  inferHarnessMode,
  resolveSkillsRoot,
} from "@agency/core";
import {
  aliasesForSkill,
  extractTldr,
  loadManifestSkills,
  parseSkillMd,
  resolveSkillMdPath,
  resolveSkillName,
  SKILL_ALIASES,
} from "@agency/skills-bridge";

function exitError(message: string): never {
  console.error(message);
  process.exit(1);
}

export function registerSkill(program: Command) {
  const skill = program
    .command("skill")
    .description("List, inspect, and invoke CodexAI skills from the skills pack");

  skill
    .command("list")
    .description("List skills from the pack manifest")
    .action(() => {
      const skillsRoot = resolveSkillsRoot();
      const skills = loadManifestSkills(skillsRoot);
      if (skills.length === 0) {
        console.log("No skills in manifest.");
        return;
      }
      for (const name of skills) {
        const aliases = aliasesForSkill(name);
        const aliasSuffix =
          aliases.length > 0 ? `  (${aliases.join(", ")})` : "";
        console.log(`${name}${aliasSuffix}`);
      }
    });

  skill
    .command("show")
    .description("Show skill metadata and TL;DR")
    .argument("<name-or-alias>", "Skill name or alias (e.g. $plan, plan-writer)")
    .action((nameOrAlias: string) => {
      const skillsRoot = resolveSkillsRoot();
      let path: string;
      try {
        path = resolveSkillMdPath(skillsRoot, nameOrAlias);
      } catch (err) {
        exitError(err instanceof Error ? err.message : String(err));
      }

      const parsed = parseSkillMd(path);
      const tldr = extractTldr(parsed.body);
      const aliases = aliasesForSkill(parsed.name);

      console.log(`name: ${parsed.name}`);
      if (aliases.length > 0) {
        console.log(`aliases: ${aliases.join(", ")}`);
      }
      if (parsed.description) {
        console.log(`description: ${parsed.description}`);
      }
      console.log(`path: ${path}`);
      console.log(`mode: ${inferHarnessMode(parsed.name)}`);
      if (tldr) {
        console.log("\n## TL;DR\n");
        console.log(tldr);
      }
    });

  skill
    .command("invoke")
    .description("Resolve alias to skill path and harness mode hint")
    .argument("<alias>", "Skill alias (e.g. $plan)")
    .action((alias: string) => {
      const skillsRoot = resolveSkillsRoot();
      if (!Object.prototype.hasOwnProperty.call(SKILL_ALIASES, alias)) {
        console.warn(
          `Warning: "${alias}" is not a registered alias; resolving as skill name.`
        );
      }

      let path: string;
      try {
        path = resolveSkillMdPath(skillsRoot, alias);
      } catch (err) {
        exitError(err instanceof Error ? err.message : String(err));
      }

      const skillName = resolveSkillName(alias);
      const mode = inferHarnessMode(skillName);
      const config = getHarnessConfig(mode);

      console.log(`skill: ${skillName}`);
      console.log(`path: ${path}`);
      console.log(harnessModeHint(skillName));
      if (config.hintSkills?.length && mode !== "default") {
        console.log(`load hints: ${config.hintSkills.join(", ")}`);
      }

      const projectRoot = getWorkspaceRoot(process.cwd());
      const actions = getInvokeActions(skillName, projectRoot);
      if (actions.length > 0) {
        console.log("\nNext steps:");
        for (const line of actions) {
          console.log(`  ${line}`);
        }
      }
    });
}
