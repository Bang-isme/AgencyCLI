import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarkdownMemoryStore } from "../index.js";

describe("MarkdownMemoryStore (curated cross-session markdown memory)", () => {
  let root: string;
  let store: MarkdownMemoryStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agency-mdmem-"));
    store = new MarkdownMemoryStore(join(root, "memory"));
  });
  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  describe("slug + frontmatter round-trip", () => {
    it("slugifies arbitrary description text to a safe kebab filename", () => {
      expect(store.upsert({ description: "User prefers TypeScript!", type: "user", body: "x" })).toBe("user-prefers-typescript");
      expect(store.upsert({ description: "   ", body: "x" })).toBe("memory");
    });

    it("write→read round-trips frontmatter + body exactly", () => {
      store.upsert({ name: "x", description: "a fact", type: "project", body: "the body\nline2" });
      expect(store.get("x")).toEqual({ name: "x", description: "a fact", type: "project", body: "the body\nline2" });
    });

    it("read is tolerant: a hand-written file with no frontmatter / unknown type falls back, no throw", () => {
      store.upsert({ name: "seed", description: "s", body: "s" }); // creates the memory dir
      writeFileSync(join(root, "memory", "fb.md"), "just a body, no frontmatter", "utf8");
      expect(store.get("fb")).toEqual({ name: "fb", description: "", type: "project", body: "just a body, no frontmatter" });
      writeFileSync(join(root, "memory", "bt.md"), "---\nname: bt\ndescription: d\nmetadata:\n  type: bogus\n---\nbody", "utf8");
      expect(store.get("bt")!.type).toBe("project");
    });
  });

  describe("upsert / get / list / remove", () => {
    it("upsert writes a topic file readable back via get + list, and returns the slug", () => {
      const slug = store.upsert({ description: "User likes pnpm", type: "user", body: "Always use pnpm, never npm." });
      expect(slug).toBe("user-likes-pnpm");
      expect(existsSync(join(root, "memory", "user-likes-pnpm.md"))).toBe(true);
      const got = store.get("user-likes-pnpm");
      expect(got).toMatchObject({ type: "user", description: "User likes pnpm" });
      expect(store.list()).toHaveLength(1);
    });

    it("upsert by same name replaces (no duplicate file)", () => {
      store.upsert({ name: "pref", description: "v1", type: "user", body: "one" });
      store.upsert({ name: "pref", description: "v2", type: "user", body: "two" });
      expect(store.list()).toHaveLength(1);
      expect(store.get("pref")!.body).toBe("two");
    });

    it("remove deletes the file and updates the index", () => {
      store.upsert({ name: "tmp", description: "d", type: "project", body: "b" });
      expect(store.remove("tmp")).toBe(true);
      expect(store.get("tmp")).toBeUndefined();
      expect(store.remove("tmp")).toBe(false);
    });
  });

  describe("index", () => {
    it("rebuilds MEMORY.md grouped by type with one line per memory", () => {
      store.upsert({ name: "p", description: "a project fact", type: "project", body: "..." });
      store.upsert({ name: "u", description: "a user pref", type: "user", body: "..." });
      const idx = store.readIndex();
      expect(idx).toContain("# Agent Memory Index");
      expect(idx).toContain("## user");
      expect(idx).toContain("## project");
      expect(idx).toContain("[a user pref](u.md)");
      expect(idx).toContain("[a project fact](p.md)");
    });
  });

  describe("recall", () => {
    it("empty store recalls nothing", () => {
      expect(store.recall({ query: "anything" })).toBe("");
    });

    it("always surfaces user/feedback memories as standing instructions", () => {
      store.upsert({ name: "pref", description: "use pnpm", type: "user", body: "Always pnpm." });
      store.upsert({ name: "unrelated", description: "some db note", type: "project", body: "schema details" });
      const block = store.recall({ query: "totally different topic" });
      expect(block).toContain("STANDING instructions");
      expect(block).toContain("Always pnpm."); // user memory present despite no query match
    });

    it("orders project memories by keyword overlap with the query (most relevant first)", () => {
      store.upsert({ name: "auth", description: "auth uses JWT", type: "project", body: "tokens via JWT middleware" });
      store.upsert({ name: "css", description: "styling with tailwind", type: "project", body: "utility classes" });
      const block = store.recall({ query: "how does JWT authentication work" });
      // The JWT memory matches the query → it is ordered before the unrelated one.
      expect(block.indexOf("tokens via JWT middleware")).toBeLessThan(block.indexOf("utility classes"));
    });

    it("respects the char budget (drops the least-relevant bodies beyond it)", () => {
      store.upsert({ name: "big1", description: "d1", type: "project", body: "X".repeat(500) });
      store.upsert({ name: "big2", description: "d2", type: "project", body: "Y".repeat(500) });
      const block = store.recall({ query: "d", charBudget: 300 });
      // budget too small for both 500-char bodies → at most one body block fits
      const bodyBlocks = (block.match(/### d\d/g) ?? []).length;
      expect(bodyBlocks).toBeLessThanOrEqual(1);
    });

    it("survives an unreadable/garbage topic file (parse-tolerant, never throws)", () => {
      store.upsert({ name: "good", description: "ok", type: "user", body: "fine" });
      writeFileSync(join(root, "memory", "garbage.md"), "\x00\x01 not valid frontmatter", "utf8");
      expect(() => store.recall({ query: "x" })).not.toThrow();
      expect(store.recall({ query: "x" })).toContain("fine");
    });
  });
});
