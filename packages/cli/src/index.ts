#!/usr/bin/env node
import { Command } from "commander";
import { resolveTuiLaunch } from "./tui-launch.js";

const program = new Command()
  .name("agency")
  .description("Agency CLI — CodexAI skills harness")
  .version("0.1.0");

const tuiPlan = resolveTuiLaunch(process.argv);

if (tuiPlan.launch) {
  // Launching the TUI must not drag in the headless command graph
  // (every `register*` module transitively loads core/providers/security/…).
  // Keeping this import dynamic shaves ~0.9s off TUI cold start.
  const { render } = await import("@agency/tui");
  render({ project: tuiPlan.project });
} else {
  // Likewise, only load the full command graph once we know we're headless.
  const { registerCommands } = await import("./register.js");
  registerCommands(program);
  program.parse();
}
