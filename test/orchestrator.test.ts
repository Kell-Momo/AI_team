import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, PROJECT_ROOT } from "../src/config.ts";
import { loadSampleData } from "../src/analytics/sample.ts";
import { run, RunBusyError, ValidationError, validateInput } from "../src/orchestrator.ts";

const sampleData = loadSampleData(join(PROJECT_ROOT, "data"));
const EXAMPLE_1 = JSON.parse(readFileSync(join(PROJECT_ROOT, "input_examples", "example_1.json"), "utf8")) as Record<string, unknown>;
const EXAMPLE_2 = JSON.parse(readFileSync(join(PROJECT_ROOT, "input_examples", "example_2.json"), "utf8")) as Record<string, unknown>;
const EXAMPLE_3 = JSON.parse(readFileSync(join(PROJECT_ROOT, "input_examples", "example_3.json"), "utf8")) as Record<string, unknown>;

// Each test gets its own project root: fresh .memory/, logs/ and outbox/.
function withRoot(fn: (deps: Parameters<typeof run>[1] & object, root: string) => Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "growthloop-run-"));
    try {
      await fn({ config: loadConfig({ SAMPLE_MODE: "true" }, root), sampleData, traceOut: () => {} }, root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

const keys = (o: object) => Object.keys(o).sort();

test(
  "a sample-mode run returns exactly the frontend contract",
  withRoot(async (deps, root) => {
    const result = await run(EXAMPLE_1, deps);
    assert.deepEqual(keys(result), ["data_quality", "execution_time_seconds", "memory", "models", "output", "run_id", "source", "status", "trace"]);
    assert.equal(result.status, "completed");
    assert.equal(result.source, "sample");
    assert.deepEqual(result.models, []); // SAMPLE_MODE never calls a model
    assert.deepEqual(keys(result.output), ["insights", "plan", "recommendations", "rejected", "summary"]);
    assert.ok(result.output.insights.length > 0);
    for (const i of result.output.insights) assert.deepEqual(keys(i), ["evidence", "id", "statement"]);
    assert.equal(result.output.plan.length, 5);
    assert.deepEqual(keys(result.memory), ["recalled", "stored"]);
    assert.deepEqual(result.memory.recalled, []); // fresh memory
    assert.ok(result.memory.stored > 0);
    assert.deepEqual(result.data_quality, { total_posts: 65, valid_posts: 62, invalid_posts: 3 });
    for (const e of result.trace) {
      assert.deepEqual(keys(e), ["action", "agent_name", "model", "output_summary", "retry_count", "status", "target_agent", "timestamp"]);
    }
    assert.ok(result.trace.some((e) => e.status === "fallback"), "SAMPLE_MODE fallbacks must be visible");
    assert.ok(existsSync(join(root, "logs", `trace-${result.run_id}.jsonl`)));
  }),
);

test(
  "the second run recalls lessons from the first and gives feedback on them",
  withRoot(async (deps) => {
    const first = await run(EXAMPLE_1, deps);
    const second = await run(EXAMPLE_2, deps);
    assert.ok(second.memory.recalled.length >= 1, "expected at least one recalled lesson");
    assert.ok(second.trace.some((e) => e.agent_name === "MemoryKeeper" && e.action === "feedback" && /^(helpful|not_helpful):/.test(e.output_summary)));
    assert.notEqual(first.run_id, second.run_id);
  }),
);

test(
  "re-running the same analysis does not duplicate lessons",
  withRoot(async (deps) => {
    const first = await run(EXAMPLE_1, deps);
    const again = await run(EXAMPLE_1, deps);
    const insightEvents = again.trace.filter((e) => e.action === "store_insight");
    assert.equal(insightEvents.length, first.output.insights.length);
    // Same data, same insights: every one is recognised as already stored.
    assert.ok(insightEvents.every((e) => e.status === "info" && e.output_summary.startsWith("already in memory")));
    // The decision differs (it now builds on recalled lessons), so at most that one is new.
    assert.ok(again.memory.stored <= 1);
  }),
);

test(
  "full mode adds approved drafts and a dry-run outbox file",
  withRoot(async (deps, root) => {
    const result = await run(EXAMPLE_3, deps);
    assert.ok(result.output.drafts && result.output.drafts.length > 0);
    assert.match(result.output.outbox_file ?? "", /^outbox\/.+\.json$/);
    const outbox = JSON.parse(readFileSync(join(root, result.output.outbox_file!), "utf8")) as { status: string };
    assert.equal(outbox.status, "queued_dry_run");
    for (const agent of ["ContentCreator", "BrandReviewer", "Publisher"]) assert.ok(result.trace.some((e) => e.agent_name === agent));
  }),
);

test(
  "a second run for the same client while one is in progress is refused",
  withRoot(async (deps) => {
    const first = run(EXAMPLE_1, deps);
    await assert.rejects(run(EXAMPLE_2, deps), RunBusyError);
    await first;
    // The lock is released afterwards.
    assert.equal((await run(EXAMPLE_2, deps)).status, "completed");
  }),
);

test("invalid input is rejected with every problem listed", async () => {
  const bad = { client: "Saveurs!", mode: "draft", question: "x".repeat(501), period: { start: "2026-02-30", end: "2026-01-01" }, extra: 1 };
  await assert.rejects(run(bad), (err: unknown) => {
    assert.ok(err instanceof ValidationError);
    const all = err.details.join(" | ");
    for (const part of ["client", "mode", "question", "period.start", 'Unknown field "extra"']) assert.match(all, new RegExp(part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    return true;
  });
  assert.throws(() => validateInput({ ...EXAMPLE_1, period: { start: "2026-09-15", end: "2026-07-01" } }), /start must be on or before/);
  assert.throws(() => validateInput([]), ValidationError);
  assert.throws(() => validateInput({ ...EXAMPLE_1, question: "   " }), ValidationError);
});
