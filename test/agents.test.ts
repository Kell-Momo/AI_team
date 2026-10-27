import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_ROOT } from "../src/config.ts";
import { loadSampleData } from "../src/analytics/sample.ts";
import { CATALOGUE, getQuery, QueryError, type Period } from "../src/analytics/queries.ts";
import { runQuery, type QueryDeps, type QueryResult } from "../src/analytics/source.ts";
import { createTracer, type Tracer } from "../src/trace.ts";
import { noLlm, parseJson, type Llm } from "../src/agents/ports.ts";
import { deterministicClaims, gatherData, proposeClaims, repairClaim, reviseClaims } from "../src/agents/analyst.ts";
import { checkClaim, reviewClaims } from "../src/agents/critic.ts";
import { deterministicStrategy, planWeek, PLAN_SIZE } from "../src/agents/strategist.ts";
import {
  checkBrandRules,
  createDrafts,
  publishDryRun,
  reviewDrafts,
  reviseDrafts,
  templateDraft,
} from "../src/agents/content.ts";
import type { Claim, PlanSlot } from "../src/agents/types.ts";

const AUDIT: Period = { start: "2026-07-01", end: "2026-09-15" };
const FULL: Period = { start: "2026-07-01", end: "2026-10-20" };
const USL = "lightning.metastore.growthloop.marketing";
const sampleData = loadSampleData(join(PROJECT_ROOT, "data"));
const sampleDeps: QueryDeps = { sampleMode: true, sampleData, usl: USL, runSql: async () => [] };

const tmpDirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "growthloop-agents-"));
  tmpDirs.push(dir);
  return dir;
};
after(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const quietTracer = (): Tracer => createTracer({ logsDir: tmp(), stdout: () => {} });

/** Fake model: canned reply per agent name; agents without a reply get null (no model). */
const cannedLlm =
  (replies: Record<string, string>, model = "test/canned-model"): Llm =>
  async (req) =>
    req.agent in replies ? { text: replies[req.agent]!, model } : null;

async function results(period: Period): Promise<QueryResult[]> {
  return Promise.all(CATALOGUE.map((spec) => runQuery(spec, period, sampleDeps)));
}

// ---------- ports ----------

test("parseJson reads fenced, embedded and nested JSON, and returns null on garbage", () => {
  assert.deepEqual(parseJson('Sure!\n```json\n{"a": [1, {"b": "x}y"}]}\n```\nDone.'), { a: [1, { b: "x}y" }] });
  assert.deepEqual(parseJson('Here you go: {"claims": []} hope it helps'), { claims: [] });
  assert.deepEqual(parseJson('<think>maybe {"no": 1}</think>[1, 2]'), [1, 2]);
  assert.equal(parseJson("no json here"), null);
  assert.equal(parseJson('{"a": 1,}'), null);
  assert.equal(parseJson('{"a": "unterminated'), null);
});

// ---------- catalogue ----------

test("every catalogue query's compute() returns exactly its declared columns", () => {
  for (const period of [AUDIT, FULL]) {
    for (const spec of CATALOGUE) {
      const rows = spec.compute(sampleData, period);
      assert.ok(rows.length > 0, `${spec.id} returned no rows`);
      for (const row of rows) assert.deepEqual(Object.keys(row), [...spec.columns], spec.id);
      assert.ok(spec.columns.includes(spec.primaryMetric), spec.id);
    }
  }
});

test("segment queries only count valid rows and data_quality counts the invalid ones", () => {
  const [dq] = getQuery("data_quality")!.compute(sampleData, FULL);
  const invalid = sampleData.post_performance.filter((r) => !(r.reach > 0 && r.engagements <= r.reach)).length;
  assert.equal(dq!.invalid_posts, invalid);
  assert.equal(dq!.valid_posts, (dq!.total_posts as number) - invalid);
  const posts = getQuery("format_performance")!.compute(sampleData, FULL).reduce((n, r) => n + (r.posts as number), 0);
  assert.equal(posts, dq!.valid_posts);
});

test("sql() targets the USL tables and rejects unsafe periods and namespaces", () => {
  for (const spec of CATALOGUE) {
    const sql = spec.sql(AUDIT, USL);
    assert.match(sql, new RegExp(`${USL.replace(/\./g, "\\.")}\\.(post_performance|campaign_daily|orders)`));
    assert.ok(sql.includes("'2026-07-01'") && sql.includes("'2026-09-15'"), spec.id);
    assert.ok(!sql.includes(";"), spec.id);
    for (const bad of [
      { start: "2026-07-01' OR '1'='1", end: "2026-09-15" },
      { start: "2026-02-30", end: "2026-09-15" },
      { start: "2026-09-15", end: "2026-07-01" },
    ]) {
      assert.throws(() => spec.sql(bad, USL), QueryError);
    }
    assert.throws(() => spec.sql(AUDIT, "x; DROP TABLE y"), QueryError);
  }
});

test("runQuery maps Zetaris string rows to the same typed columns as sample mode", async () => {
  const spec = getQuery("format_performance")!;
  const sample = await runQuery(spec, AUDIT, sampleDeps);
  assert.equal(sample.source, "sample");
  let seenSql = "";
  const zetaris = await runQuery(spec, AUDIT, {
    sampleMode: false,
    usl: USL,
    runSql: async (sql) => {
      seenSql = sql;
      return sample.rows.map((r) => spec.columns.map((c) => String(r[c])));
    },
  });
  assert.equal(zetaris.source, "zetaris");
  assert.equal(seenSql, spec.sql(AUDIT, USL));
  assert.deepEqual(zetaris.rows, sample.rows);
});

test("gatherData logs a failed query and continues with the rest", async () => {
  const tracer = quietTracer();
  const gathered = await gatherData(AUDIT, {
    sampleMode: false,
    usl: USL,
    runSql: async (sql) => {
      if (sql.includes("LIMIT 5")) throw new Error("boom");
      return [];
    },
  }, tracer);
  assert.equal(gathered.length, CATALOGUE.length - 1);
  assert.ok(!gathered.some((r) => r.id === "top_posts"));
  const errors = tracer.events().filter((e) => e.status === "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.output_summary, /skipped: boom/);
});

// ---------- EvidenceCritic ----------

function correctClaim(res: QueryResult[]): Claim {
  const rows = res.find((r) => r.id === "format_performance")!.rows.filter((r) => (r.posts as number) >= 3);
  const best = rows[0]!;
  const worst = rows[rows.length - 1]!;
  const rb = best.avg_engagement_rate as number;
  const rw = worst.avg_engagement_rate as number;
  return {
    id: "c1",
    statement: `${best.segment} posts average ${(rb * 100).toFixed(2)}% engagement against ${(rw * 100).toFixed(2)}% for ${worst.segment} posts, ${(rb / rw).toFixed(2)} times higher.`,
    evidence: [
      { query: "format_performance", segment: String(best.segment), metric: "avg_engagement_rate", value: rb },
      { query: "format_performance", segment: String(worst.segment), metric: "avg_engagement_rate", value: rw },
    ],
  };
}

test("critic approves a correct claim", async () => {
  const res = await results(AUDIT);
  const verdict = checkClaim(correctClaim(res), res);
  assert.equal(verdict.approved, true, verdict.reasons.join(" "));
  assert.ok(verdict.checks.every((c) => c.ok));
});

test("critic rejects a wrong number in the evidence and in the statement", async () => {
  const res = await results(AUDIT);
  const good = correctClaim(res);
  const wrongEvidence: Claim = { ...good, evidence: [{ ...good.evidence[0]!, value: good.evidence[0]!.value * 1.1 }, good.evidence[1]!] };
  const v1 = checkClaim(wrongEvidence, res);
  assert.equal(v1.approved, false);
  assert.match(v1.reasons.join(" "), /cited .*, actual/);
  assert.equal(v1.checks[0]!.actual, good.evidence[0]!.value);

  const v2 = checkClaim({ ...good, statement: `${good.statement} Engagement doubled (2.00 times).` }, res);
  assert.equal(v2.approved, false);
  assert.match(v2.reasons.join(" "), /Number "2\.00"/);
});

test("critic rejects an unknown segment, an unknown query and causal wording", async () => {
  const res = await results(AUDIT);
  const good = correctClaim(res);
  const unknownSegment = checkClaim({ ...good, evidence: [{ ...good.evidence[0]!, segment: "hologram" }] }, res);
  assert.equal(unknownSegment.approved, false);
  assert.match(unknownSegment.reasons.join(" "), /Unknown segment "hologram"/);
  assert.equal(unknownSegment.checks[0]!.actual, null);

  const unknownQuery = checkClaim({ ...good, evidence: [{ ...good.evidence[0]!, query: "secret_sales" }] }, res);
  assert.match(unknownQuery.reasons.join(" "), /Unknown query/);

  const causal = checkClaim({ ...good, statement: `${good.statement} Reels drive engagement.` }, res);
  assert.match(causal.reasons.join(" "), /causal/);

  const sales = checkClaim({ ...good, statement: `${good.statement} They also bring more sales.` }, res);
  assert.match(sales.reasons.join(" "), /sales or revenue/);
});

test("deterministic claims on the sample data: at least 5, all approved by the critic", async () => {
  for (const period of [AUDIT, FULL]) {
    const res = await results(period);
    const tracer = quietTracer();
    const { value: claims, model } = await proposeClaims("Audit our content", res, "", { llm: noLlm, tracer });
    assert.equal(model, null);
    assert.ok(claims.length >= 5, `only ${claims.length} claims`);
    assert.deepEqual(claims, deterministicClaims(res));
    assert.ok(claims.some((c) => c.evidence[0]!.query === "promo_roi"), "promo ROI claim missing");
    const verdicts = await reviewClaims(claims, res, { llm: noLlm, tracer, round: 0, final: false });
    for (const [i, v] of verdicts.entries()) assert.equal(v.approved, true, `${claims[i]!.statement}: ${v.reasons.join(" ")}`);
    const propose = tracer.events().find((e) => e.action === "propose_claims")!;
    assert.equal(propose.status, "fallback");
    assert.ok(tracer.events().filter((e) => e.action === "verify_claim").every((e) => e.target_agent === "Strategist"));
  }
});

test("model claims are used when valid; a rejected one goes back to DataAnalyst and is repaired", async () => {
  const res = await results(AUDIT);
  const good = correctClaim(res);
  const wrong = { ...good, statement: good.statement, evidence: [{ ...good.evidence[0]!, value: 0.5 }, good.evidence[1]!] };
  const llm = cannedLlm({
    DataAnalyst: `\`\`\`json\n${JSON.stringify({ claims: [{ ...good, id: "x" }, { ...wrong, id: "y" }, { id: "z", statement: "no evidence here at all", evidence: [] }] })}\n\`\`\``,
  });
  const tracer = quietTracer();
  const { value: claims, model } = await proposeClaims("q", res, "", { llm, tracer });
  assert.equal(model, "test/canned-model");
  assert.deepEqual(claims.map((c) => c.id), ["c1", "c2"]); // invalid claim dropped, ids reassigned

  const verdicts = await reviewClaims(claims, res, { llm, tracer, round: 0, final: false });
  assert.deepEqual(verdicts.map((v) => v.approved), [true, false]);
  const rejectedEvent = tracer.events().find((e) => e.action === "verify_claim" && e.status === "needs_revision")!;
  assert.equal(rejectedEvent.target_agent, "DataAnalyst");

  // No model for the revision: deterministic repair with the actual values.
  const revised = await reviseClaims([{ claim: claims[1]!, verdict: verdicts[1]! }], res, { llm: noLlm, tracer, round: 1 });
  assert.equal(revised.value.length, 1);
  assert.equal(revised.value[0]!.id, "c2");
  assert.equal(checkClaim(revised.value[0]!, res).approved, true);
});

test("repairClaim recomputes percentages and ratios from the actual values", async () => {
  const res = await results(FULL);
  const good = correctClaim(res);
  const [a, b] = good.evidence;
  const wrong: Claim = {
    id: "c9",
    statement: `x posts average ${(a!.value * 80).toFixed(2)}% against ${(b!.value * 100).toFixed(2)}%, ${((a!.value * 0.8) / b!.value).toFixed(2)} times higher.`,
    evidence: [{ ...a!, value: a!.value * 0.8 }, b!],
  };
  const verdict = checkClaim(wrong, res);
  assert.equal(verdict.approved, false);
  const repaired = repairClaim(wrong, verdict)!;
  assert.ok(repaired.statement.includes(`${(a!.value * 100).toFixed(2)}%`), repaired.statement);
  assert.equal(checkClaim(repaired, res).approved, true);
  // Overreach cannot be repaired by changing numbers.
  assert.equal(repairClaim(good, { ...verdict, reasons: ["Overreach: causal wording"] }), null);
});

test("the model overreach review can reject a claim but never approve a wrong one", async () => {
  const res = await results(AUDIT);
  const good = correctClaim(res);
  const wrong: Claim = { ...good, id: "c2", evidence: [{ ...good.evidence[0]!, value: 0.9 }, good.evidence[1]!] };
  const llm = cannedLlm({
    EvidenceCritic: JSON.stringify({ reviews: [{ id: "c1", overreach: true, reason: "generalises to all customers" }, { id: "c2", overreach: false }] }),
  });
  const tracer = quietTracer();
  const verdicts = await reviewClaims([good, wrong], res, { llm, tracer, round: 2, final: true });
  assert.equal(verdicts[0]!.approved, false);
  assert.match(verdicts[0]!.reasons.join(" "), /model review/);
  assert.equal(verdicts[1]!.approved, false);
  const events = tracer.events().filter((e) => e.action === "verify_claim");
  assert.ok(events.every((e) => e.status === "rejected" && e.target_agent === null && e.retry_count === 2));
  assert.equal(events[0]!.model, "test/canned-model");
});

// ---------- Strategist ----------

test("deterministic strategy: 5 valid slots, recommendations cite approved claims", async () => {
  const res = await results(AUDIT);
  const claims = deterministicClaims(res);
  const promoCodes = new Set(res.find((r) => r.id === "promo_roi")!.rows.map((r) => String(r.promo_code)));
  const tracer = quietTracer();
  const { value, model } = await planWeek("q", claims, "", 0, promoCodes, { llm: noLlm, tracer, nextAgent: "ContentCreator" });
  assert.equal(model, null);
  assert.equal(value.plan.length, PLAN_SIZE);
  const ids = new Set(claims.map((c) => c.id));
  assert.ok(value.recommendations.length > 0 && value.recommendations.every((r) => r.claim_ids.every((id) => ids.has(id))));
  for (const slot of value.plan) {
    assert.ok(Number.isInteger(slot.post_hour) && slot.post_hour >= 0 && slot.post_hour <= 23);
    if (slot.promo_code) assert.ok(promoCodes.has(slot.promo_code));
  }
  assert.equal(tracer.events()[0]!.status, "fallback");
  assert.equal(deterministicStrategy("q", [], 0).recommendations.length, 0);
});

test("model strategy is used when valid; unknown claim ids and promo codes are dropped", async () => {
  const claims: Claim[] = [{ id: "c1", statement: "s", evidence: [{ query: "format_performance", segment: "reel", metric: "posts", value: 1 }] }];
  const slot = { day: "Monday", platform: "instagram", format: "reel", pillar: "menu", language: "fr", post_hour: 19, angle: "a", promo_code: "FAKE99" };
  const reply = {
    summary: "Reels work.",
    recommendations: [{ action: "More reels", why: "c1", claim_ids: ["c1", "c42"] }, { action: "Invented", why: "?", claim_ids: ["c42"] }],
    plan: Array.from({ length: PLAN_SIZE }, () => slot),
  };
  const tracer = quietTracer();
  const { value, model } = await planWeek("q", claims, "", 0, new Set(["NDOLE10"]), {
    llm: cannedLlm({ Strategist: JSON.stringify(reply) }),
    tracer,
    nextAgent: "MemoryKeeper",
  });
  assert.equal(model, "test/canned-model");
  assert.deepEqual(value.recommendations, [{ action: "More reels", why: "c1", claim_ids: ["c1"] }]);
  assert.ok(value.plan.every((p) => p.promo_code === undefined));
  assert.equal(tracer.events()[0]!.target_agent, "MemoryKeeper");

  // A 4-post plan fails validation: rule-based fallback, not a half-trusted model answer.
  const short = await planWeek("q", claims, "", 0, new Set(), {
    llm: cannedLlm({ Strategist: JSON.stringify({ ...reply, plan: reply.plan.slice(1) }) }),
    tracer,
    nextAgent: "MemoryKeeper",
  });
  assert.equal(short.model, null);
});

// ---------- Content ----------

const okDraft = { caption: "Ndolé-plantain du jour, seulement 3 500 FCFA. Commandez sur WhatsApp au +237 690 00 00 00.", hashtags: ["#Douala"] };

test("brand rules pass a clean draft and catch each violation", () => {
  assert.deepEqual(checkBrandRules(okDraft), []);
  const cases: [string, RegExp][] = [
    [`${okDraft.caption} ${"Miam ".repeat(50)}`, /Too long/],
    ["Ndolé-plantain du jour, seulement 3 500 FCFA. Passez nous voir à Akwa.", /No WhatsApp/],
    ["Ndolé-plantain du jour. Commandez sur WhatsApp au +237 690 00 00 00.", /No price in FCFA/],
    [`${okDraft.caption} About 5 EUR.`, /Currency other than FCFA/],
    [`${okDraft.caption} Also 3500 XAF.`, /Currency other than FCFA/],
    [`${okDraft.caption} Best in Douala!`, /superlative/],
    [`${okDraft.caption} We are number 1.`, /superlative/],
    [`${okDraft.caption} Le meilleur de Douala.`, /superlative/],
    [`${okDraft.caption} Le meilleur ndolé à Douala.`, /superlative/],
    [`${okDraft.caption} Goût garanti.`, /superlative/],
    [`${okDraft.caption} N°1 du ndolé.`, /superlative/],
  ];
  for (const [caption, expected] of cases) {
    const issues = checkBrandRules({ caption, hashtags: okDraft.hashtags });
    assert.ok(issues.some((i) => expected.test(i)), `${caption} -> ${issues.join(" | ") || "no issue"}`);
  }
});

test("template drafts pass the brand rules for every language and pillar", () => {
  let i = 0;
  for (const language of ["fr", "en", "pidgin"]) {
    for (const pillar of ["menu", "promo", "behind_scenes", "customer_story"]) {
      for (const promo_code of [undefined, "NDOLE10"]) {
        const slot: PlanSlot = { day: "Monday", platform: "instagram", format: "reel", pillar, language, post_hour: 19, angle: "a", ...(promo_code ? { promo_code } : {}) };
        const draft = templateDraft(slot, i++);
        assert.deepEqual(checkBrandRules(draft), [], draft.caption);
        if (promo_code && pillar === "promo") assert.ok(draft.caption.includes(promo_code));
      }
    }
  }
});

test("content flow: model drafts reviewed, failing ones revised once, outbox written as dry run", async () => {
  const plan = deterministicStrategy("q", deterministicClaims(await results(AUDIT)), 0).plan;
  const llm = cannedLlm({
    ContentCreator: JSON.stringify({
      drafts: [
        { slot: 1, caption: "Le meilleur ndolé de Douala, garanti ! Commandez sur WhatsApp.", hashtags: ["#Douala"] },
        { slot: 2, caption: okDraft.caption, hashtags: ["#Douala", "not a hashtag"] },
      ],
    }),
  });
  const tracer = quietTracer();
  const created = await createDrafts(plan, { llm, tracer });
  assert.equal(created.model, "test/canned-model");
  assert.equal(created.value.length, PLAN_SIZE);
  assert.deepEqual(created.value[1]!.hashtags, ["#Douala"]);
  assert.equal(created.value[1]!.platform, plan[1]!.platform); // plan fields never come from the model

  const first = await reviewDrafts(created.value, { llm: noLlm, tracer, round: 0 });
  assert.equal(first[0]!.approved, false);
  assert.ok(first.slice(1).every((r) => r.approved));

  const revised = await reviseDrafts(created.value, first, plan, { llm: noLlm, tracer });
  const second = await reviewDrafts(revised.value, { llm: noLlm, tracer, round: 1 });
  assert.ok(second.every((r) => r.approved));

  const outbox = join(tmp(), "outbox");
  const out = publishDryRun({ runId: "run-test-1", client: "saveurs-de-douala", drafts: revised.value, reviews: second, outboxDir: outbox, tracer });
  assert.equal(out.file, "outbox/run-test-1.json");
  assert.equal(out.queued, PLAN_SIZE);
  const file = JSON.parse(readFileSync(join(outbox, "run-test-1.json"), "utf8"));
  assert.equal(file.status, "queued_dry_run");
  assert.ok(file.posts.every((p: { status: string }) => p.status === "queued_dry_run"));
  assert.throws(() => publishDryRun({ runId: "../escape", client: "x", drafts: [], reviews: [], outboxDir: outbox, tracer }));
});
