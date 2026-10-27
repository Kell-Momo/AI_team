import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { loadConfig } from "../src/config.ts";
import { createAppServer, MAX_BODY_BYTES } from "../src/server.ts";
import { RunBusyError, validateInput } from "../src/orchestrator.ts";
import type { RunResponse } from "../frontend/src/types.ts";

let server: Server;
let base = "";
let root = "";

// The real validation, a stubbed run: these tests cover HTTP behaviour, not the agents.
const fakeRun = async (body: unknown) => {
  const input = validateInput(body);
  if (input.client === "busy-client") throw new RunBusyError(input.client);
  if (input.client === "boom") throw new Error("secret internals at /home/x/file.ts:12");
  return { run_id: "r1", status: "completed" } as RunResponse;
};

before(async () => {
  root = mkdtempSync(join(tmpdir(), "growthloop-server-"));
  const dist = join(root, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>GrowthLoop</title>");
  writeFileSync(join(dist, "assets", "app.js"), "console.log(1)");
  writeFileSync(join(root, "secret.txt"), "do not serve");
  server = createAppServer({ config: loadConfig({ SAMPLE_MODE: "true" }, root), run: fakeRun as never, distDir: dist });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

const valid = { client: "saveurs-de-douala", mode: "analyze", question: "What worked?", period: { start: "2026-07-01", end: "2026-09-15" } };
const post = (body: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }) =>
  fetch(`${base}/run`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

test("GET /health answers JSON", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(((await res.json()) as { status: string }).status, "ok");
  assert.equal(res.headers.get("access-control-allow-origin"), null); // no CORS wildcard
});

test("POST /run returns the run result", async () => {
  const res = await post(valid);
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as RunResponse).run_id, "r1");
});

test("invalid input -> 400 {error:{code,message,details}}", async () => {
  const res = await post({ ...valid, client: "../etc" });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: { code: string; message: string; details: string[] } };
  assert.equal(body.error.code, "invalid_input");
  assert.ok(body.error.details.some((d) => d.includes("client")));
});

test("bad JSON -> 400, wrong content type -> 415, too large -> 413", async () => {
  assert.equal((await post("{not json")).status, 400);
  assert.equal((await post(valid, { "Content-Type": "text/plain" })).status, 415);
  const big = await post({ ...valid, question: "x".repeat(MAX_BODY_BYTES) });
  assert.equal(big.status, 413);
  assert.equal(((await big.json()) as { error: { code: string } }).error.code, "payload_too_large");
});

test("a run already in progress for the client -> 409", async () => {
  const res = await post({ ...valid, client: "busy-client" });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, "run_in_progress");
});

test("unexpected errors -> 500 without internals", async () => {
  const res = await post({ ...valid, client: "boom" });
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.doesNotMatch(text, /secret internals|file\.ts|at /);
  assert.equal((JSON.parse(text) as { error: { code: string } }).error.code, "internal_error");
});

test("wrong method -> 405", async () => {
  assert.equal((await fetch(`${base}/run`)).status, 405);
  assert.equal((await fetch(`${base}/health`, { method: "DELETE" })).status, 405);
});

test("serves the UI, falls back to index.html for app routes, and blocks path traversal", async () => {
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /GrowthLoop/);
  assert.equal((await fetch(`${base}/assets/app.js`)).status, 200);
  assert.match(await (await fetch(`${base}/some/app/route`)).text(), /GrowthLoop/);
  assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404);
  for (const path of ["/..%2fsecret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt", "/..%5csecret.txt"]) {
    const res = await fetch(`${base}${path}`);
    assert.doesNotMatch(await res.text(), /do not serve/, path);
  }
});
