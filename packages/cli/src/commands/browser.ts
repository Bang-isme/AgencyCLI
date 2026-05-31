import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { getBrowserMcpStatus, getWorkspaceRoot } from "@agency/core";
import { handleError } from "../utils.js";

function openWithSystemBrowser(url: string): number {
  if (process.platform === "win32") {
    const result = spawnSync("cmd", ["/c", "start", "", url], {
      stdio: "ignore",
      shell: false,
    });
    return result.status ?? (result.error ? 1 : 0);
  }

  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  const result = spawnSync(cmd, [url], { stdio: "ignore", shell: false });
  return result.status ?? (result.error ? 1 : 0);
}

export function registerBrowser(program: Command) {
  const browser = program
    .command("browser")
    .description("Browser automation bridge (Cursor IDE Browser MCP)");

  browser
    .command("status")
    .description("Check browser MCP configuration for this project")
    .option("--project-root <path>", "Project root directory")
    .action((opts: { projectRoot?: string }) => {
      try {
        const projectRoot = opts.projectRoot ?? getWorkspaceRoot(process.cwd());
        const status = getBrowserMcpStatus(projectRoot);
        process.stdout.write(JSON.stringify(status, null, 2) + "\n");
      } catch (err) {
        handleError(err, "browser status failed");
      }
    });

  browser
    .command("open")
    .description("Open a URL (full automation requires Cursor IDE Browser MCP)")
    .argument("<url>", "URL to open")
    .option("--system", "Open URL with the system default browser")
    .option("--project-root <path>", "Project root directory")
    .action((url: string, opts: { system?: boolean; projectRoot?: string }) => {
      try {
        const projectRoot = opts.projectRoot ?? getWorkspaceRoot(process.cwd());
        const { configured, hint } = getBrowserMcpStatus(projectRoot);

        console.log(hint);
        if (!configured) {
          console.log(
            "\nBrowser MCP is not detected in this project. Enable cursor-ide-browser in Cursor to use agent-driven browser automation."
          );
        } else {
          console.log(
            "\nBrowser MCP appears configured. Use Cursor agent tools for automated navigation and interaction."
          );
        }

        if (opts.system) {
          const code = openWithSystemBrowser(url);
          process.exit(code === 0 ? 0 : 1);
        }

        console.log("\nPass --system to open the URL in your default browser without MCP.");
        process.exit(configured ? 0 : 1);
      } catch (err) {
        handleError(err, "browser open failed");
      }
    });
}
