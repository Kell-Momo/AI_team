import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PROJECT_ROOT } from "../src/config.ts";
import { loadSampleData, parseCsv, SampleDataError } from "../src/analytics/sample.ts";

test("parseCsv handles quoted commas, escaped quotes, newlines and CRLF", () => {
  const text = 'a,"b, c","say ""hi"""\r\n1,"two\nlines",\n\n';
  assert.deepEqual(parseCsv(text), [
    ["a", "b, c", 'say "hi"'],
    ["1", "two\nlines", ""],
  ]);
});

test("parseCsv rejects malformed quoting", () => {
  assert.throws(() => parseCsv('a,"open\n'), SampleDataError);
  assert.throws(() => parseCsv('a,"x"y\n'), SampleDataError);
});

let dataDir = "";
before(() => {
  dataDir = mkdtempSync(join(tmpdir(), "growthloop-sample-"));
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", join(PROJECT_ROOT, "scripts", "generate-data.ts"), "--out", dataDir],
    { cwd: PROJECT_ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
});
after(() => rmSync(dataDir, { recursive: true, force: true }));

// Counted from raw lines, independently of the parser (captions contain no newlines).
const dataLines = (file: string) =>
  readFileSync(join(dataDir, file), "utf8").split("\n").filter((l) => l !== "").length - 1;

test("loader row counts match the CSVs", () => {
  const data = loadSampleData(dataDir);
  assert.equal(data.post_performance.length, dataLines("posts.csv"));
  assert.equal(data.post_performance.length, dataLines("post_metrics.csv"));
  assert.equal(data.campaign_daily.length, dataLines("ad_spend.csv"));
  assert.equal(data.orders.length, dataLines("sales.csv"));
});

test("post_performance joins metrics and derives engagements and posted_date", () => {
  const data = loadSampleData(dataDir);
  const firstMetric = readFileSync(join(dataDir, "post_metrics.csv"), "utf8").split("\n")[1]!.split(",");
  const [postId, reach, likes, comments, shares, saves, linkClicks] = firstMetric;
  const row = data.post_performance.find((r) => r.post_id === postId);
  assert.ok(row);
  assert.equal(row.reach, Number(reach));
  assert.equal(row.engagements, Number(likes) + Number(comments) + Number(shares) + Number(saves));
  assert.equal(row.link_clicks, Number(linkClicks));
  for (const r of data.post_performance) assert.match(r.posted_date, /^\d{4}-\d{2}-\d{2}$/);
});

test("loader rejects a row with the wrong number of fields", () => {
  const bad = mkdtempSync(join(tmpdir(), "growthloop-bad-"));
  try {
    writeFileSync(join(bad, "posts.csv"), `${readFileSync(join(dataDir, "posts.csv"), "utf8")}P999,extra\n`);
    assert.throws(() => loadSampleData(bad), SampleDataError);
  } finally {
    rmSync(bad, { recursive: true, force: true });
  }
});
