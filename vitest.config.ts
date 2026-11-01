import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": "./test/cloudflare-workers.ts",
    },
  },
  test: {
    include: ["test/**/*.spec.ts"],
    server: {
      deps: {
        inline: ["@cloudflare/workers-oauth-provider"],
      },
    },
    coverage: {
      include: ["src/**/*.ts"],
      reporter: ["text"],
      thresholds: {
        lines: 80,
      },
    },
  },
});
