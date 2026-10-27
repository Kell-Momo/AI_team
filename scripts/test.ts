// Node 20's test runner neither discovers .ts files nor expands globs (and npm on Windows
// runs scripts via cmd.exe, which doesn't either), so list test files ourselves.
import { readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { PROJECT_ROOT } from "../src/config.ts";

function findTests(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return findTests(full);
    return entry.name.endsWith(".test.ts") ? [relative(PROJECT_ROOT, full)] : [];
  });
}

const files = process.argv.length > 2 ? process.argv.slice(2) : findTests(join(PROJECT_ROOT, "test"));
if (files.length === 0) {
  console.log("No test files found under test/.");
  process.exit(0);
}

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
  cwd: PROJECT_ROOT,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
