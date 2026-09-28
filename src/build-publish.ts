import { randomUUID } from "node:crypto";
import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";
import { BUILDS, switchDist } from "./self-update.js";

/** Where `npm run build` and `npm run dev` write before publishing; never live. */
export const STAGING = ".dist-staging";

/**
 * Keeps local builds from writing into the live build. When no `--outDir` is given, Vite builds into a private
 * staging directory; after each successful build (every `npm run dev` rebuild too) a copy goes to a fresh
 * `builds/<name>` and `dist` is switched to it atomically. Self-updates pass `--outDir builds/...` and are left alone.
 */
export function publishBuild(): Plugin {
  let root = process.cwd();
  let staging: string | undefined;
  let failed = false;
  return {
    name: "indra-publish-build",
    apply: "build",
    config(config) {
      if (config.build?.outDir) return;
      return { build: { outDir: STAGING, emptyOutDir: true } };
    },
    configResolved(config) {
      root = config.root;
      staging = resolve(root, config.build.outDir) === resolve(root, STAGING) ? resolve(root, STAGING) : undefined;
    },
    buildStart() { failed = false; },
    renderError() { failed = true; },
    buildEnd(error) { if (error) failed = true; },
    async closeBundle() {
      if (!staging || failed) return;
      const name = `local-${Date.now()}-${randomUUID().slice(0, 8)}`;
      await mkdir(join(root, BUILDS), { recursive: true });
      await cp(staging, join(root, BUILDS, name), { recursive: true });
      try { await switchDist(root, name); } catch (error) {
        await rm(join(root, BUILDS, name), { recursive: true, force: true });
        throw error;
      }
    },
  };
}
