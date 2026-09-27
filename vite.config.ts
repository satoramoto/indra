import { transformAsync } from "@babel/core";
import { defineConfig, type Plugin } from "vitest/config";

function solidTerminalTransform(): Plugin {
  return {
    name: "solid-terminal-transform",
    enforce: "pre",
    async transform(source, id) {
      if (!id.endsWith(".tsx")) return;
      const result = await transformAsync(source, {
        filename: id,
        babelrc: false,
        configFile: false,
        plugins: [["babel-plugin-module-resolver", {
          resolvePath(specifier: string) {
            if (specifier === "solid-js") return "solid-js/dist/solid.js";
            if (specifier === "solid-js/store") return "solid-js/store/dist/store.js";
            return specifier;
          },
        }]],
        presets: [["babel-preset-solid", { moduleName: "@opentui/solid", generate: "universal" }], ["@babel/preset-typescript", { isTSX: true, allExtensions: true }]],
      });
      return result?.code ? { code: result.code, map: result.map } : undefined;
    },
  };
}

export default defineConfig({
  plugins: [solidTerminalTransform()],
  build: {
    target: "node26",
    minify: false,
    lib: { entry: { cli: "src/cli.ts", "terminal-ui": "src/terminal-ui-solid.tsx" }, formats: ["es"] },
    rollupOptions: { external: [/^node:/, /^@opentui\//, /^solid-js/] },
  },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});
