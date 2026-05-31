import { Command } from "commander";
import {
  ApprovalRequiredError,
  getWorkspaceRoot,
  runShellCommand,
} from "@agency/core";

export function registerRun(program: Command) {
  program
    .command("run")
    .argument("<command>", "Shell command to execute")
    .description("Run a shell command in the project sandbox")
    .option("--project-root <path>", "Project root directory")
    .option("--yes", "Approve commands that match destructive patterns")
    .option("--sandbox-mode <mode>", "Execution sandbox mode ('docker' or 'native')", "native")
    .option("--docker-image <image>", "Docker image to run command in (default: node:22-alpine)")
    .option("--docker-network-disabled", "Disable network access in Docker container")
    .option("--docker-memory <limit>", "Container memory limit (e.g. 512m)")
    .option("--docker-cpu <limit>", "Container CPU limit (e.g. 0.5)")
    .action(async (command: string, options: {
      projectRoot?: string;
      yes?: boolean;
      sandboxMode?: "docker" | "native";
      dockerImage?: string;
      dockerNetworkDisabled?: boolean;
      dockerMemory?: string;
      dockerCpu?: string;
    }) => {
      const projectRoot = options.projectRoot ?? getWorkspaceRoot(process.cwd());
      
      const sandboxMode = options.sandboxMode ?? "native";
      if (sandboxMode === "native") {
        console.warn("Warning: Running command natively on host. Use --sandbox-mode docker for sandboxed execution.");
      }

      try {
        const { exitCode } = await runShellCommand(projectRoot, command, {
          yes: options.yes,
          sandboxMode,
          dockerImage: options.dockerImage,
          dockerNetworkDisabled: options.dockerNetworkDisabled,
          dockerMemoryLimit: options.dockerMemory,
          dockerCpuLimit: options.dockerCpu,
        });
        process.exit(exitCode === 0 ? 0 : 1);
      } catch (err) {
        if (err instanceof ApprovalRequiredError) {
          console.error(err.message);
          process.exit(1);
        }
        throw err;
      }
    });
}

