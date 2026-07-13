import { describe, expect, it } from "vitest";
import { runVerification } from "../product/verification.js";

describe("runVerification", () => {
  it("reports an unconfigured project without calling a runner", async () => {
    const result = await runVerification("/project", [], async () => {
      throw new Error("runner must not be called");
    });

    expect(result).toMatchObject({ state: "not_configured", gates: [] });
    expect(result.recoveryHint).toContain("Add project scripts");
  });

  it("stops at the first failed gate with a usable recovery action", async () => {
    const calls: string[][] = [];
    const result = await runVerification(
      "/project",
      [["npm", "run", "lint"], ["npm", "test"]],
      async (command) => {
        calls.push(command);
        return command.at(-1) === "lint"
          ? { exitCode: 1, stderr: "lint error" }
          : { exitCode: 0, stdout: "ok" };
      }
    );

    expect(calls).toEqual([["npm", "run", "lint"]]);
    expect(result).toMatchObject({
      state: "failed",
      summary: "lint error",
      gates: [{ id: "lint", state: "failed", outputTail: "lint error" }],
    });
    expect(result.recoveryHint).toBe("Fix lint and run npm run lint.");
  });

  it("returns one shared passing result for every completed gate", async () => {
    const result = await runVerification(
      "/project",
      [["npm", "run", "build"], ["npm", "test"]],
      async () => ({ exitCode: 0, stdout: "ok" })
    );

    expect(result.state).toBe("passed");
    expect(result.gates.map((gate) => gate.id)).toEqual(["build", "test"]);
  });
});
