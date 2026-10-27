import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PROJECT_ROOT } from "../src/config.ts";
import { parseCsvRecords, CSV_COLUMNS } from "../src/analytics/sample.ts";

const FILES = ["posts.csv", "post_metrics.csv", "ad_spend.csv", "sales.csv"] as const;
const dirs: string[] = [];

// Runs the real CLI (not an imported function) so the test covers exactly what `npm run data:generate` does.
function generate(): string {
  const dir = mkdtempSync(join(tmpdir(), "growthloop-data-"));
  dirs.push(dir);
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", join(PROJECT_ROOT, "scripts", "generate-data.ts"), "--out", dir],
    { cwd: PROJECT_ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return dir;
}

let first = "";
let second = "";

before(() => {
  first = generate();
  second = generate();
});

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");

test("two runs produce byte-identical CSVs", () => {
  for (const file of FILES) assert.equal(read(first, file), read(second, file), `${file} differs between runs`);
});

test("exactly 3 metric rows break the data-quality rule", () => {
  const rows = parseCsvRecords(read(first, "post_metrics.csv"), CSV_COLUMNS.post_metrics, "post_metrics.csv");
  const invalid = rows.filter((r) => {
    const reach = Number(r.reach);
    const engagements = Number(r.likes) + Number(r.comments) + Number(r.shares) + Number(r.saves);
    return !(reach > 0 && engagements <= reach);
  });
  assert.equal(invalid.length, 3);
});

test("origin follows the 2026-09-16 cut-over and the post count is about 95", () => {
  const posts = parseCsvRecords(read(first, "posts.csv"), CSV_COLUMNS.posts, "posts.csv");
  assert.ok(posts.length >= 85 && posts.length <= 105, `got ${posts.length} posts`);
  for (const p of posts) {
    const expected = p.posted_at! < "2026-09-16" ? "existing" : "app";
    assert.equal(p.origin, expected, `${p.post_id} posted ${p.posted_at}`);
  }
});

test("every promo code belongs to exactly one campaign and is used in sales", () => {
  const ads = parseCsvRecords(read(first, "ad_spend.csv"), CSV_COLUMNS.ad_spend, "ad_spend.csv");
  const sales = parseCsvRecords(read(first, "sales.csv"), CSV_COLUMNS.sales, "sales.csv");
  const posts = parseCsvRecords(read(first, "posts.csv"), CSV_COLUMNS.posts, "posts.csv");

  const campaignsByCode = new Map<string, Set<string>>();
  for (const a of ads) campaignsByCode.set(a.promo_code!, (campaignsByCode.get(a.promo_code!) ?? new Set()).add(a.campaign_id!));
  assert.equal(campaignsByCode.size, 5);
  for (const [code, campaigns] of campaignsByCode) assert.equal(campaigns.size, 1, `${code} spans campaigns`);

  const salesCodes = new Set(sales.map((s) => s.promo_code).filter(Boolean));
  assert.deepEqual([...salesCodes].sort(), [...campaignsByCode.keys()].sort());
  for (const p of posts) if (p.promo_code) assert.ok(campaignsByCode.has(p.promo_code), `unknown code on ${p.post_id}`);
});
