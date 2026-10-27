import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarketingMemory } from "../src/engines/memory.ts";

function withDir(fn: (dir: string) => void | Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "growthloop-memory-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const INSIGHT =
  "Among post formats with at least 3 posts, reel posts have the highest average engagement rate (8.17% over 24 posts), against 4.10% for text posts (11 posts).";

test(
  "a lesson stored by one instance is recalled by a new instance on the same folder",
  withDir((dir) => {
    const first = new MarketingMemory({ client: "saveurs-de-douala", rootDir: dir });
    const id = first.rememberInsight(INSIGHT, ["q:format_performance", "best:reel"], "run-1");
    first.rememberDecision("Plan: 3 reels, evening slots, Pidgin captions.", "run-1");
    assert.ok(existsSync(join(dir, "saveurs-de-douala", "state.json")));

    const second = new MarketingMemory({ client: "saveurs-de-douala", rootDir: dir });
    const { lessons, context } = second.recall("Which post formats engage best, and what should we post next week?");
    const lesson = lessons.find((l) => l.id === id);
    assert.ok(lesson, `expected ${id} in ${JSON.stringify(lessons)}`);
    assert.ok(lesson.tags.includes("q:format_performance") && lesson.tags.includes("best:reel"));
    assert.ok(lesson.relevance > 0);
    assert.match(context, /reel posts have the highest/);
  }),
);

test(
  "memories are per client",
  withDir((dir) => {
    new MarketingMemory({ client: "client-a", rootDir: dir }).rememberInsight(INSIGHT, [], "run-1");
    const other = new MarketingMemory({ client: "client-b", rootDir: dir });
    assert.equal(other.recall("Which post formats engage best?").lessons.length, 0);
  }),
);

test(
  "feedback changes confidence by the H-MEM deltas and persists",
  withDir((dir) => {
    const memory = new MarketingMemory({ client: "saveurs-de-douala", rootDir: dir });
    const id = memory.rememberInsight(INSIGHT, ["best:reel"], "run-1");
    assert.equal(memory.get(id)?.confidence, 0.7);

    memory.feedback(id, "helpful");
    assert.ok(Math.abs(memory.get(id)!.confidence - 0.75) < 1e-9);
    memory.feedback(id, "not_helpful");
    assert.ok(Math.abs(memory.get(id)!.confidence - 0.72) < 1e-9);

    const reloaded = new MarketingMemory({ client: "saveurs-de-douala", rootDir: dir });
    assert.ok(Math.abs(reloaded.get(id)!.confidence - 0.72) < 1e-9);
    reloaded.feedback(id, "wrong");
    assert.ok(Math.abs(reloaded.get(id)!.confidence - 0.52) < 1e-9);
    assert.ok(reloaded.get(id)!.tags.includes("review"));
  }),
);

test("rejects client slugs that are not safe folder names", () => {
  for (const client of ["../etc", "A", "Saveurs", "x".repeat(41), "a/b"]) {
    assert.throws(() => new MarketingMemory({ client, rootDir: tmpdir() }), /Invalid client slug/);
  }
});
