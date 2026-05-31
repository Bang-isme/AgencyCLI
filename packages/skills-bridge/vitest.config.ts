import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@agency/core/approval": resolve(
        __dirname,
        "../core/src/approval/index.ts"
      ),
    },
  },
  test: {
    environment: "node",
  },
});
