import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const attempt = (operation: () => void) => {
  try { operation(); return "allowed"; }
  catch (error) { return (error as NodeJS.ErrnoException).code; }
};
const [deniedFile, ...dirs] = process.argv.slice(2);
const protectedRead = attempt(() => { readFileSync(deniedFile); });
const results = dirs.map((dir) => {
  return {
    read: readFileSync(join(dir, "read.txt"), "utf8"),
    create: attempt(() => writeFileSync(join(dir, "created.txt"), "created")),
    overwrite: attempt(() => writeFileSync(join(dir, "overwrite.txt"), "changed")),
    append: attempt(() => appendFileSync(join(dir, "append.txt"), "changed")),
    rename: attempt(() => renameSync(join(dir, "rename.txt"), join(dir, "renamed.txt"))),
    delete: attempt(() => unlinkSync(join(dir, "delete.txt"))),
    mkdir: attempt(() => mkdirSync(join(dir, "created-dir"))),
  };
});
process.stdout.write(JSON.stringify({ results, protectedRead }));
