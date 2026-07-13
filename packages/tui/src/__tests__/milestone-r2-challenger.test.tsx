import { describe, expect, it } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { GitReviewService, SessionService, type SessionMessage } from "@agency/core";
import { filterSlashMenu } from "../presentation/slash-menu.js";
import { HelpOverlay } from "../components/HelpOverlay.js";
import { getTheme, DEFAULT_THEME_ID } from "../themes/registry.js";
import { resolveThoughtExpansion } from "../components/Conversation.js";

const theme = getTheme(DEFAULT_THEME_ID);

describe("Milestone R2 Challenger Empirical Verification", () => {

  describe("1. Git Review Service", () => {
    it("sanitizeDiff correctly suppresses .env and lockfiles, while preserving standard diffs", () => {
      const rawDiff = [
        "diff --git a/.env b/.env",
        "--- a/.env",
        "+++ b/.env",
        "@@ -1,1 +1,1 @@",
        "-SECRET=123",
        "+SECRET=456",
        "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
        "--- a/pnpm-lock.yaml",
        "+++ b/pnpm-lock.yaml",
        "@@ -1,1 +1,1 @@",
        "-foo",
        "+bar",
        "diff --git a/src/main.ts b/src/main.ts",
        "--- a/src/main.ts",
        "+++ b/src/main.ts",
        "@@ -1,1 +1,1 @@",
        "-console.log(1);",
        "+console.log(2);"
      ].join("\n");

      const sanitized = GitReviewService.sanitizeDiff(rawDiff);

      // Verify lockfile suppressed
      expect(sanitized).toContain("[Diff suppressed for excluded file: pnpm-lock.yaml]");
      expect(sanitized).not.toContain("-foo");
      expect(sanitized).not.toContain("+bar");

      // Verify secret redacted / suppressed
      expect(sanitized).toContain("[Diff suppressed for excluded file: .env]");
      expect(sanitized).not.toContain("-SECRET=123");
      expect(sanitized).not.toContain("+SECRET=456");

      // Verify normal diff is preserved
      expect(sanitized).toContain("diff --git a/src/main.ts b/src/main.ts");
      expect(sanitized).toContain("-console.log(1);");
      expect(sanitized).toContain("+console.log(2);");
    });

    it("sanitizeDiff handles edge cases of .env and lockfile names adversarially", () => {
      const rawDiff = [
        "diff --git a/packages/tui/.env b/packages/tui/.env",
        "--- a/packages/tui/.env",
        "+++ b/packages/tui/.env",
        "@@ -1,1 +1,1 @@",
        "-SECRET=123",
        "+SECRET=456",
        "diff --git a/.env.production b/.env.production",
        "--- a/.env.production",
        "+++ b/.env.production",
        "@@ -1,1 +1,1 @@",
        "+DB_PASS=abc",
        "diff --git a/config.env.json b/config.env.json",
        "--- a/config.env.json",
        "+++ b/config.env.json",
        "@@ -1,1 +1,1 @@",
        "+{}",
        "diff --git a/packages/core/pnpm-lock.yaml b/packages/core/pnpm-lock.yaml",
        "--- a/packages/core/pnpm-lock.yaml",
        "+++ b/packages/core/pnpm-lock.yaml",
        "@@ -1,1 +1,1 @@",
        "+lock",
        "diff --git a/pnpm-lock.yaml.bak b/pnpm-lock.yaml.bak",
        "--- a/pnpm-lock.yaml.bak",
        "+++ b/pnpm-lock.yaml.bak",
        "@@ -1,1 +1,1 @@",
        "+lockbak",
        "diff --git a/src/main.env.ts b/src/main.env.ts",
        "--- a/src/main.env.ts",
        "+++ b/src/main.env.ts",
        "@@ -1,1 +1,1 @@",
        "+const isEnv = true;",
      ].join("\n");

      const sanitized = GitReviewService.sanitizeDiff(rawDiff);

      // Verify nested .env is suppressed
      expect(sanitized).toContain("[Diff suppressed for excluded file: packages/tui/.env]");
      expect(sanitized).not.toContain("-SECRET=123");

      // Verify .env.production is suppressed
      expect(sanitized).toContain("[Diff suppressed for excluded file: .env.production]");
      expect(sanitized).not.toContain("+DB_PASS=abc");

      // Verify config.env.json is NOT suppressed
      expect(sanitized).not.toContain("[Diff suppressed for excluded file: config.env.json]");
      expect(sanitized).toContain("+{}");

      // Verify nested pnpm-lock.yaml is suppressed
      expect(sanitized).toContain("[Diff suppressed for excluded file: packages/core/pnpm-lock.yaml]");

      // Verify pnpm-lock.yaml.bak is NOT suppressed
      expect(sanitized).not.toContain("[Diff suppressed for excluded file: pnpm-lock.yaml.bak]");
      expect(sanitized).toContain("+lockbak");

      // Verify main.env.ts is NOT suppressed
      expect(sanitized).not.toContain("[Diff suppressed for excluded file: src/main.env.ts]");
      expect(sanitized).toContain("+const isEnv = true;");
    });

    it("formatReviewPrompt generates correct markdown structure", () => {
      const reviewCtx = {
        summary: {
          available: true,
          branch: "feature/r2",
          isClean: false,
          staged: 2,
          unstaged: 1,
          untracked: 0,
          recentCommits: [],
          ghAvailable: false,
        },
        fileList: [
          { status: "M", path: "src/main.ts" },
          { status: "D", path: "pnpm-lock.yaml" },
        ],
        stagedDiff: "staged-diff-data",
        unstagedDiff: "unstaged-diff-data",
        truncated: true,
        estimatedTokens: 42,
      };

      const prompt = GitReviewService.formatReviewPrompt(reviewCtx, "Please review it carefully.");

      expect(prompt).toContain("## Git Review Context");
      expect(prompt).toContain("Branch: `feature/r2`");
      expect(prompt).toContain("Staged: 2, Unstaged: 1, Untracked: 0");
      expect(prompt).toContain("- `[M]` src/main.ts");
      expect(prompt).toContain("- `[D]` pnpm-lock.yaml");
      expect(prompt).toContain("staged-diff-data");
      expect(prompt).toContain("unstaged-diff-data");
      expect(prompt).toContain("Please review it carefully.");
      expect(prompt).toContain("(Note: Diff output was truncated to fit character/token limits)");
    });
  });

  describe("2. Session Service", () => {
    it("sanitizeAndRepairSession repairs unclosed XML tool_call tags", () => {
      const messages: SessionMessage[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: "Let me do this: <tool_call name=\"test_tool\"><arg>value</arg>",
          timestamp: 100,
        }
      ];

      const repaired = SessionService.sanitizeAndRepairSession(messages);
      expect(repaired[0].content).toBe("Let me do this: <tool_call name=\"test_tool\"><arg>value</arg></tool_call>");
    });

    it("appends synthetic system message if assistant tool call is unanswered", () => {
      const messages: SessionMessage[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: "<tool_call name=\"test\"></tool_call>",
          timestamp: 100,
        }
      ];

      const repaired = SessionService.sanitizeAndRepairSession(messages);
      expect(repaired.length).toBe(2);
      expect(repaired[1].role).toBe("system");
      expect(repaired[1].content).toBe("[SESSION RESUMED: Tool execution interrupted]");
    });

    it("does NOT append synthetic system message if assistant tool call has a response", () => {
      const messages: SessionMessage[] = [
        {
          id: "msg-1",
          role: "assistant",
          content: "<tool_call name=\"test\"></tool_call>",
          timestamp: 100,
        },
        {
          id: "msg-2",
          role: "system",
          content: "<tool_response>Success</tool_response>",
          timestamp: 101,
        }
      ];

      const repaired = SessionService.sanitizeAndRepairSession(messages);
      expect(repaired.length).toBe(2);
      expect(repaired[1].id).toBe("msg-2");
    });

    it("sanitizeAndRepairSession closes all tags when multiple are unclosed", () => {
      const messages: SessionMessage[] = [
        {
          id: "msg-multi-unclosed",
          role: "assistant",
          content: "<tool_call name=\"toolA\"><arg>1</arg> and <tool_call name=\"toolB\"><arg>2</arg>",
          timestamp: 100,
        }
      ];
      const repaired = SessionService.sanitizeAndRepairSession(messages);
      // It will append two </tool_call> tags
      expect(repaired[0].content).toBe("<tool_call name=\"toolA\"><arg>1</arg> and <tool_call name=\"toolB\"><arg>2</arg></tool_call></tool_call>");
    });
  });

  describe("3. Slash Menu Autocomplete", () => {
    it("returns core commands plus virtual expander command when query is empty and isExpanded is false", () => {
      const items = filterSlashMenu("", false);
      
      // Verify expander command is present
      const expander = items.find(item => item.isExpander);
      expect(expander).toBeDefined();
      expect(expander?.name).toBe("more");
      
      // Verify all items except expander are core tier
      const regularItems = items.filter(item => !item.isExpander);
      for (const item of regularItems) {
        expect(item.tier).toBe("core");
      }
    });

    it("returns core + advanced commands and NO expander command when query is empty and isExpanded is true", () => {
      const items = filterSlashMenu("", true);
      
      // Verify expander command is NOT present
      const expander = items.find(item => item.isExpander);
      expect(expander).toBeUndefined();
      
      // Verify both core and advanced tiers are returned
      const tiers = new Set(items.map(item => item.tier));
      expect(tiers.has("core")).toBe(true);
      expect(tiers.has("advanced")).toBe(true);
    });

    it("queries all capabilities and sorts core first when query is non-empty", () => {
      const items = filterSlashMenu("t");
      
      // Verify no expander is present
      expect(items.find(item => item.isExpander)).toBeUndefined();

      // Verify that core tier commands are sorted before advanced tier commands
      let foundAdvanced = false;
      for (const item of items) {
        if (item.tier === "advanced") {
          foundAdvanced = true;
        } else if (item.tier === "core") {
          // If we found an advanced command earlier, no core command should appear after it
          expect(foundAdvanced).toBe(false);
        }
      }
    });

    it("does not crash when query contains regex special characters", () => {
      const items = filterSlashMenu(".*+?^${}()|[]\\");
      expect(items).toBeDefined();
    });
  });

  describe("4. Help Overlay", () => {
    it("renders core shortcuts and commands, showing collapse banner by default", () => {
      const { lastFrame } = render(
        <HelpOverlay theme={theme} cols={80} onClose={() => {}} />
      );
      const frame = lastFrame() || "";
      expect(frame).toContain("KEYBOARD SHORTCUTS");
      expect(frame).toContain("SLASH COMMANDS");
      expect(frame).toContain("Press Tab / Space to reveal");
    });

    it("filters shortcuts and commands interactively when stdin receives characters", async () => {
      const { lastFrame, stdin } = render(
        <HelpOverlay theme={theme} cols={80} onClose={() => {}} />
      );

      // Wait for component to mount and bind key listeners
      await new Promise((r) => setTimeout(r, 100));

      // Input "theme" character by character to simulate keyboard typing
      for (const char of "theme") {
        stdin.write(char);
        await new Promise((r) => setTimeout(r, 10));
      }
      await new Promise((r) => setTimeout(r, 50));

      const frame = lastFrame() || "";
      expect(frame).toContain("Filter: [ theme ]");
      // Check that the theme command is shown
      expect(frame).toContain("/theme");
    });

    it("does NOT append Enter/Return key to searchQuery", async () => {
      const { lastFrame, stdin } = render(
        <HelpOverlay theme={theme} cols={80} onClose={() => {}} />
      );

      // Wait for component to mount and bind key listeners
      await new Promise((r) => setTimeout(r, 100));

      for (const char of "theme") {
        stdin.write(char);
        await new Promise((r) => setTimeout(r, 10));
      }
      // Write Enter (carriage return)
      stdin.write("\r");
      await new Promise((r) => setTimeout(r, 50));

      const frame = lastFrame() || "";
      expect(frame).toContain("Filter: [ theme ]");
      expect(frame).toContain("/theme");
    });

    it("toggles advanced commands when space or tab is pressed", async () => {
      const { lastFrame, stdin } = render(
        <HelpOverlay theme={theme} cols={80} onClose={() => {}} />
      );

      // Wait for component to mount
      await new Promise((r) => setTimeout(r, 100));

      const frameBefore = lastFrame() || "";
      expect(frameBefore).toContain("Press Tab / Space to reveal");

      // Press space to expand
      stdin.write(" ");
      await new Promise((r) => setTimeout(r, 50));

      const frameAfter = lastFrame() || "";
      // Advanced section should be expanded, banner should be gone
      expect(frameAfter).not.toContain("Press Tab / Space to reveal");
    });
  });

  describe("5. Reasoning Collapse", () => {
    it("collapses thought expansion by default (when not streaming and not manually expanded)", () => {
      const shouldExpand = resolveThoughtExpansion(
        false, // expandedTui
        true,  // isLastMessage
        false, // streaming
        true   // autoExpandThinking
      );
      expect(shouldExpand).toBe(false);
    });

    it("auto-expands when streaming is true and autoExpandThinking is true", () => {
      const shouldExpand = resolveThoughtExpansion(
        false, // expandedTui
        false, // isLastMessage
        true,  // streaming
        true   // autoExpandThinking
      );
      expect(shouldExpand).toBe(true);
    });

    it("collapses when streaming ends even if autoExpandThinking is true", () => {
      const shouldExpand = resolveThoughtExpansion(
        false, // expandedTui
        false, // isLastMessage
        false, // streaming
        true   // autoExpandThinking
      );
      expect(shouldExpand).toBe(false);
    });

    it("manually expands last message via ctrl+o (expandedTui = true)", () => {
      const shouldExpand = resolveThoughtExpansion(
        true,  // expandedTui
        true,  // isLastMessage
        false, // streaming
        true   // autoExpandThinking
      );
      expect(shouldExpand).toBe(true);
    });

    it("does NOT manually expand non-last messages via ctrl+o", () => {
      const shouldExpand = resolveThoughtExpansion(
        true,  // expandedTui
        false, // isLastMessage
        false, // streaming
        true   // autoExpandThinking
      );
      expect(shouldExpand).toBe(false);
    });
  });
});
