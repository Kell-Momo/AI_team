// Runs the vendored H-MEM conformance suite against the vendored reference implementation.
// A wrapper because npm on Windows runs scripts via cmd.exe, where `HMEM_IMPL=... tsx` doesn't work.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { PROJECT_ROOT } from "../src/config.ts";

const result = spawnSync(process.execPath, ["--import", "tsx", join(PROJECT_ROOT, "vendor", "hmem-conformance", "runner.ts")], {
  cwd: PROJECT_ROOT,
  stdio: "inherit",
  env: { ...process.env, HMEM_IMPL: join(PROJECT_ROOT, "vendor", "hmem", "index.ts") },
});
process.exit(result.status ?? 1);
