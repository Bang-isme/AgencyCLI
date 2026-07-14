import { Command } from "commander";
import { capabilityRegistry } from "@agency/core";
import { describe, expect, it } from "vitest";
import { registerCommands } from "../register.js";

describe("CLI command capability registry", () => {
  it("gives every public command one canonical capability descriptor or alias", () => {
    const program = new Command();
    registerCommands(program);
    const missing = program.commands
      .map((command) => command.name())
      .filter((name) => !capabilityRegistry.get(name));

    expect(missing).toEqual([]);
  });
});
