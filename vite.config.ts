import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    target: "node22",
    minify: false,
    lib: { entry: "src/cli.ts", formats: ["es"], fileName: "cli" },
    rollupOptions: { external: [/^node:/] },
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
