import { describe, expect, it } from "vitest";
import { filterSlashMenu, getSlashQuery } from "../slash-menu.js";

describe("slash menu", () => {
  it("detects slash query from buffer", () => {
    expect(getSlashQuery("/hel")).toEqual({ query: "hel" });
    expect(getSlashQuery("hello")).toBeNull();
    expect(getSlashQuery("/")).toEqual({ query: "" });
  });

  it("filters commands by prefix", () => {
    const items = filterSlashMenu("th");
    expect(items.some((i) => i.name === "theme")).toBe(true);
    expect(items.some((i) => i.name === "help")).toBe(false);
  });
});
