import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ProcessJail } from "../process-jail.js";

describe("ProcessJail Suite", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should instantiate without errors on any platform", () => {
    const jail = new ProcessJail();
    expect(jail).toBeDefined();
    jail.dispose();
  });

  it("should attach process successfully", () => {
    const jail = new ProcessJail();
    const pid = 99999;
    const attached = jail.attachProcess(pid);
    
    // On POSIX it should always succeed, on Windows it depends on FFI status.
    if (process.platform !== "win32") {
      expect(attached).toBe(true);
    } else {
      // On Windows it might fail if we cannot open process 99999
      expect(typeof attached).toBe("boolean");
    }
    jail.dispose();
  });

  it("should call killAll and dispose without errors", () => {
    const jail = new ProcessJail();
    jail.attachProcess(12345);

    const spyKill = vi.spyOn(process, "kill").mockImplementation(() => true);

    expect(() => jail.killAll()).not.toThrow();
    
    if (process.platform !== "win32") {
      expect(spyKill).toHaveBeenCalledWith(-12345, "SIGKILL");
    }

    expect(() => jail.dispose()).not.toThrow();
    
    spyKill.mockRestore();
  });
});
