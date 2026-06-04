import { describe, it, expect } from "vitest";
import { clipboardReadCommand, clipboardWriteCommand } from "../utils/clipboard.js";

describe("clipboard platform command mapping", () => {
  it("read: win32 Get-Clipboard, darwin pbpaste, linux xclip→wl-paste", () => {
    expect(clipboardReadCommand("win32").cmd).toContain("Get-Clipboard");
    expect(clipboardReadCommand("darwin").cmd).toBe("pbpaste");
    const linux = clipboardReadCommand("linux");
    expect(linux.cmd).toContain("xclip");
    expect(linux.fallback).toBe("wl-paste");
  });

  it("write: win32 clip, darwin pbcopy, linux xclip→wl-copy", () => {
    expect(clipboardWriteCommand("win32").cmd).toBe("clip");
    expect(clipboardWriteCommand("darwin").cmd).toBe("pbcopy");
    const linux = clipboardWriteCommand("linux");
    expect(linux.cmd).toContain("xclip");
    expect(linux.fallback).toBe("wl-copy");
  });

  it("only Linux carries a fallback (X11 ↔ Wayland)", () => {
    expect(clipboardWriteCommand("win32").fallback).toBeUndefined();
    expect(clipboardWriteCommand("darwin").fallback).toBeUndefined();
    expect(clipboardReadCommand("win32").fallback).toBeUndefined();
    expect(clipboardReadCommand("darwin").fallback).toBeUndefined();
  });
});
