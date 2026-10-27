// Entry point.
//   tsx run.ts <input.json> [--out <file>]   run once, print the JSON result (trace lines go to stderr)
//   tsx run.ts serve                         start the HTTP server
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ConfigError, getConfig } from "./src/config.ts";
import { run, RunBusyError, RunFailedError, ValidationError } from "./src/orchestrator.ts";
import { startServer } from "./src/server.ts";

const USAGE = "Usage: tsx run.ts <input.json> [--out <file>]  |  tsx run.ts serve";

async function main(argv: readonly string[]): Promise<number> {
  const [first, ...rest] = argv;
  if (!first || first === "--help" || first === "-h") {
    console.error(USAGE);
    return first ? 0 : 2;
  }
  if (first === "serve") {
    startServer(getConfig());
    return -1; // keep running
  }

  let out: string | undefined;
  if (rest[0] === "--out" && rest[1]) out = resolve(rest[1]);
  else if (rest.length > 0) {
    console.error(USAGE);
    return 2;
  }

  let input: unknown;
  try {
    input = JSON.parse(readFileSync(first, "utf8"));
  } catch (err) {
    console.error(`Cannot read ${first} as JSON: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  try {
    // Trace lines to stderr so stdout is the JSON result alone (pipe-able).
    const result = await run(input, { traceOut: (line) => process.stderr.write(`${line}\n`) });
    const json = `${JSON.stringify(result, null, 2)}\n`;
    process.stdout.write(json);
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, json, "utf8");
      console.error(`saved ${out}`);
    }
    return result.status === "completed" ? 0 : 1;
  } catch (err) {
    if (err instanceof ValidationError) {
      process.stdout.write(`${JSON.stringify({ error: { code: err.code, message: "Invalid input", details: err.details } }, null, 2)}\n`);
      return 2;
    }
    if (err instanceof RunBusyError || err instanceof RunFailedError) {
      process.stdout.write(`${JSON.stringify({ error: { code: err.code, message: err.message } }, null, 2)}\n`);
      return 1;
    }
    throw err;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (err: unknown) => {
    console.error(err instanceof ConfigError || err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
