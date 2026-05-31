import { Command } from "commander";
import {
  addMember,
  getWorkspaceRoot,
  initTeam,
  loadTeam,
  TeamAlreadyExistsError,
  TeamMemberExistsError,
  TeamNotFoundError,
  type TeamMemberRole,
} from "@agency/core";

const ROLES: TeamMemberRole[] = ["lead", "dev", "qa", "devops"];

export function registerTeam(program: Command) {
  const team = program
    .command("team")
    .description("Shared team profile (.agency/team.json, local only)");

  team
    .command("init")
    .description("Initialize team config for this project")
    .requiredOption("--name <name>", "Team display name")
    .option("--project-root <path>", "Project root directory")
    .action((options: { name: string; projectRoot?: string }) => {
      const projectRoot =
        options.projectRoot ?? getWorkspaceRoot(process.cwd());
      try {
        const config = initTeam(projectRoot, options.name);
        console.log(JSON.stringify(config, null, 2));
      } catch (err) {
        if (err instanceof TeamAlreadyExistsError) {
          console.error(err.message);
          process.exit(1);
        }
        throw err;
      }
    });

  team
    .command("show")
    .description("Show team config as JSON")
    .option("--project-root <path>", "Project root directory")
    .action((options: { projectRoot?: string }) => {
      const projectRoot =
        options.projectRoot ?? getWorkspaceRoot(process.cwd());
      const config = loadTeam(projectRoot);
      if (!config) {
        const err = new TeamNotFoundError();
        console.error(err.message);
        process.exit(1);
      }
      console.log(JSON.stringify(config, null, 2));
    });

  const member = team.command("member").description("Manage team members");

  member
    .command("add")
    .description("Add a team member")
    .requiredOption("--id <id>", "Member id")
    .requiredOption("--name <name>", "Member display name")
    .requiredOption("--role <role>", `Role (${ROLES.join("|")})`)
    .option("--email <email>", "Member email")
    .option("--project-root <path>", "Project root directory")
    .action(
      (options: {
        id: string;
        name: string;
        role: string;
        email?: string;
        projectRoot?: string;
      }) => {
        const projectRoot =
          options.projectRoot ?? getWorkspaceRoot(process.cwd());
        if (!ROLES.includes(options.role as TeamMemberRole)) {
          console.error(`Invalid role: ${options.role}. Use: ${ROLES.join(", ")}`);
          process.exit(1);
        }
        try {
          const config = addMember(projectRoot, {
            id: options.id,
            name: options.name,
            role: options.role as TeamMemberRole,
            email: options.email,
          });
          console.log(JSON.stringify(config, null, 2));
        } catch (err) {
          if (
            err instanceof TeamNotFoundError ||
            err instanceof TeamMemberExistsError
          ) {
            console.error(err.message);
            process.exit(1);
          }
          throw err;
        }
      }
    );
}
