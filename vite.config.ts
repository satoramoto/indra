import { transformAsync } from "@babel/core";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";

/** Writes dist/build-stamp.json after every successful build (also each `npm run dev` rebuild), so running code sees it is outdated. */
function buildStamp(): Plugin {
  return {
    name: "indra-build-stamp",
    apply: "build",
    writeBundle(options) {
      let sha = "";
      try { sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* Not a Git checkout. */ }
      writeFileSync(join(options.dir ?? "dist", "build-stamp.json"), JSON.stringify({ id: randomUUID(), sha, builtAt: new Date().toISOString() }));
    },
  };
}

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
  plugins: [solidTerminalTransform(), buildStamp()],
  build: {
    target: "node26",
    minify: false,
    lib: { entry: { cli: "src/cli.ts", launcher: "src/launcher.ts", "terminal-ui": "src/terminal-ui-solid.tsx" }, formats: ["es"] },
    rollupOptions: { external: [/^node:/, /^@opentui\//, /^solid-js/] },
  },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});
