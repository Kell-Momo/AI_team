// DataAnalyst: runs the fixed query catalogue, proposes evidence-backed claims, and revises
// the ones the EvidenceCritic rejects.
import { ZetarisError } from "../adapters/zetaris.ts";
import { CATALOGUE, QUERY_IDS, type Period, type QuerySpec, type Row } from "../analytics/queries.ts";
import { runQuery, type QueryDeps, type QueryResult } from "../analytics/source.ts";
import type { Tracer } from "../trace.ts";
import { MIN_POSTS } from "./critic.ts";
import { label, LANGUAGE_NAMES, PILLAR_NAMES, PLATFORM_NAMES, TIMING_NAMES } from "./labels.ts";
import { explain, extractNumbers, formatNumber, pct } from "./numbers.ts";
import { parseJson, type Llm } from "./ports.ts";
import type { Claim, Evidence, Produced, Verdict } from "./types.ts";

export const AGENT = "DataAnalyst";
const MAX_CLAIMS = 8;

// After these, every other query would fail the same way; one clear error beats ten.
const FATAL_KINDS = new Set(["unreachable", "unauthorized", "config"]);

/** Run the catalogue. A failed query is logged and skipped; the run continues with the rest. */
export async function gatherData(
  period: Period,
  deps: QueryDeps,
  tracer: Tracer,
  catalogue: readonly QuerySpec[] = CATALOGUE,
): Promise<QueryResult[]> {
  const results: QueryResult[] = [];
  for (let i = 0; i < catalogue.length; i++) {
    const spec = catalogue[i]!;
    const input = `${spec.id} for ${period.start}..${period.end} (${deps.sampleMode ? "sample" : "zetaris"})`;
    try {
      const result = await runQuery(spec, period, deps);
      results.push(result);
      tracer.log({
        agent_name: AGENT,
        action: "run_query",
        status: "success",
        input_summary: input,
        output_summary: `${result.rows.length} rows from ${result.source} in ${result.ms} ms`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tracer.log({ agent_name: AGENT, action: "run_query", status: "error", input_summary: input, output_summary: `skipped: ${message}` });
      if (err instanceof ZetarisError && FATAL_KINDS.has(err.kind)) {
        const rest = catalogue.slice(i + 1).map((q) => q.id);
        if (rest.length > 0) {
          tracer.log({
            agent_name: AGENT,
            action: "run_query",
            status: "error",
            input_summary: rest.join(", "),
            output_summary: `not run: Zetaris ${err.kind}`,
          });
        }
        break;
      }
    }
  }
  return results;
}

/** Compact, model-readable dump of the results (they are small aggregates). */
export function formatResults(results: readonly QueryResult[]): string {
  return results
    .map((r) => [`## ${r.id}: ${r.title}`, ...r.rows.map((row) => JSON.stringify(row))].join("\n"))
    .join("\n\n");
}

const CLAIM_RULES = [
  "Every claim cites evidence copied EXACTLY from the results: query (the query id), segment (the row key:",
  'the value of "segment", "promo_code" or "post_id"; use "all" for data_quality), metric (a column name) and value (the number in that row).',
  "The first evidence item is the segment the claim is about (the winner); comparison segments follow.",
  "Every decimal, percentage or FCFA amount in the statement must be an evidence value, a rate shown as a percentage",
  "(0.0612 -> 6.12%), or a ratio of two evidence values.",
  `Only compare segments with at least ${MIN_POSTS} posts. Describe associations, never causes.`,
  "Only talk about sales or revenue when citing promo_roi.",
].join("\n");

const PROPOSE_SYSTEM = [
  "You are DataAnalyst in GrowthLoop, the marketing team of a small food business in Douala, Cameroon.",
  "You receive aggregated results from a fixed query catalogue. Propose up to 6 factual claims that help answer the question.",
  CLAIM_RULES,
  'Reply with JSON only: {"claims":[{"id":"c1","statement":"...","evidence":[{"query":"...","segment":"...","metric":"...","value":0}]}]}',
].join("\n");

const REVISE_SYSTEM = [
  "You are DataAnalyst in GrowthLoop. The EvidenceCritic rejected some of your claims and sent back the reasons and the actual values.",
  "Rewrite each claim so it is correct, using the actual values, or leave it out if it cannot be supported. Keep each claim's id.",
  CLAIM_RULES,
  'Reply with JSON only: {"claims":[{"id":"...","statement":"...","evidence":[{"query":"...","segment":"...","metric":"...","value":0}]}]}',
].join("\n");

function toEvidence(raw: unknown): Evidence | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const value = typeof e.value === "number" ? e.value : typeof e.value === "string" ? Number(e.value) : NaN;
  if (typeof e.query !== "string" || !(QUERY_IDS as readonly string[]).includes(e.query)) return null;
  if ((typeof e.segment !== "string" && typeof e.segment !== "number") || typeof e.metric !== "string") return null;
  if (!Number.isFinite(value)) return null;
  return { query: e.query, segment: String(e.segment).slice(0, 80), metric: e.metric.slice(0, 60), value };
}

/** Validate model output into claims. With allowedIds, ids must be in it (revisions keep ids). */
export function parseClaims(text: string, allowedIds?: ReadonlySet<string>): Claim[] {
  const parsed = parseJson<{ claims?: unknown }>(text);
  if (!parsed || !Array.isArray(parsed.claims)) return [];
  const claims: Claim[] = [];
  for (const raw of parsed.claims.slice(0, MAX_CLAIMS)) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    if (typeof c.statement !== "string" || c.statement.trim().length < 10 || c.statement.length > 400) continue;
    if (!Array.isArray(c.evidence) || c.evidence.length === 0 || c.evidence.length > 8) continue;
    const evidence = c.evidence.map(toEvidence);
    if (evidence.some((e) => e === null)) continue;
    let id: string;
    if (allowedIds) {
      if (typeof c.id !== "string" || !allowedIds.has(c.id) || claims.some((x) => x.id === c.id)) continue;
      id = c.id;
    } else {
      id = `c${claims.length + 1}`; // model ids are not trusted to be unique or safe
    }
    claims.push({ id, statement: c.statement.trim(), evidence: evidence as Evidence[] });
  }
  return claims;
}

const DIMENSION: Record<string, string> = {
  format_performance: "post formats",
  pillar_performance: "content pillars",
  language_performance: "languages",
  timing_performance: "times of day",
  platform_performance: "platforms",
  cta_performance: "posts grouped by call to action",
  origin_comparison: "posts grouped by origin",
};

function segmentLabel(query: string, segment: string): string {
  switch (query) {
    case "format_performance":
      return `${segment} posts`;
    case "pillar_performance":
      return `${label(PILLAR_NAMES, segment)} posts`;
    case "language_performance":
      return `posts in ${label(LANGUAGE_NAMES, segment)}`;
    case "timing_performance":
      return `${label(TIMING_NAMES, segment)} posts`;
    case "platform_performance":
      return `${label(PLATFORM_NAMES, segment)} posts`;
    case "cta_performance":
      return segment === "cta_true" ? "posts with a call to action" : "posts without a call to action";
    case "origin_comparison":
      return segment === "app" ? "posts planned with GrowthLoop" : "existing posts";
    default:
      return segment;
  }
}

const num = (row: Row, col: string) => (typeof row[col] === "number" ? (row[col] as number) : null);

function segmentClaim(result: QueryResult): Omit<Claim, "id"> | null {
  const rows = result.rows.filter((r) => (num(r, "posts") ?? 0) >= MIN_POSTS && num(r, "avg_engagement_rate") !== null);
  if (rows.length < 2) return null;
  const sorted = [...rows].sort((a, b) => num(b, "avg_engagement_rate")! - num(a, "avg_engagement_rate")!);
  const best = sorted[0]!;
  const worst = sorted[sorted.length - 1]!;
  const rb = num(best, "avg_engagement_rate")!;
  const rw = num(worst, "avg_engagement_rate")!;
  if (rb === rw) return null;
  const sb = String(best.segment);
  const sw = String(worst.segment);
  const ratio = rw > 0 ? `, ${(rb / rw).toFixed(2)} times higher` : "";
  const statement =
    `Among ${DIMENSION[result.id]} (groups of at least ${MIN_POSTS} posts), ${segmentLabel(result.id, sb)} have the highest ` +
    `average engagement rate (${pct(rb)} over ${num(best, "posts")} posts), against ${pct(rw)} for ` +
    `${segmentLabel(result.id, sw)} (${num(worst, "posts")} posts)${ratio}.`;
  const ev = (row: Row, metric: string): Evidence => ({ query: result.id, segment: String(row.segment), metric, value: num(row, metric)! });
  return {
    statement,
    evidence: [ev(best, "avg_engagement_rate"), ev(worst, "avg_engagement_rate"), ev(best, "posts"), ev(worst, "posts")],
  };
}

function promoClaim(result: QueryResult): Omit<Claim, "id"> | null {
  const rows = result.rows.filter((r) => num(r, "roas") !== null && (num(r, "orders") ?? 0) > 0 && num(r, "cost_per_order_xaf") !== null);
  if (rows.length < 2) return null;
  const sorted = [...rows].sort((a, b) => num(b, "roas")! - num(a, "roas")!);
  const best = sorted[0]!;
  const worst = sorted[sorted.length - 1]!;
  if (num(best, "roas") === num(worst, "roas")) return null;
  const money = (row: Row) => formatNumber(num(row, "cost_per_order_xaf")!, "money", 0);
  const statement =
    `Orders using promo code ${best.promo_code} add up to ${num(best, "roas")} FCFA of revenue per FCFA of ad spend ` +
    `(${num(best, "orders")} orders), against ${num(worst, "roas")} for ${worst.promo_code}; ` +
    `cost per order ${money(best)} FCFA vs ${money(worst)} FCFA.`;
  const ev = (row: Row, metric: string): Evidence => ({ query: "promo_roi", segment: String(row.promo_code), metric, value: num(row, metric)! });
  return {
    statement,
    evidence: [ev(best, "roas"), ev(worst, "roas"), ev(best, "cost_per_order_xaf"), ev(worst, "cost_per_order_xaf"), ev(best, "orders")],
  };
}

/** Fallback claims: best vs worst segment of each segment query, plus promo ROI. */
export function deterministicClaims(results: readonly QueryResult[]): Claim[] {
  const drafts: Omit<Claim, "id">[] = [];
  for (const r of results) {
    const claim = r.id in DIMENSION ? segmentClaim(r) : r.id === "promo_roi" ? promoClaim(r) : null;
    if (claim) drafts.push(claim);
  }
  return drafts.map((c, i) => ({ id: `c${i + 1}`, ...c }));
}

export interface AnalystOptions {
  llm: Llm;
  tracer: Tracer;
}

export async function proposeClaims(
  question: string,
  results: readonly QueryResult[],
  memoryContext: string,
  opts: AnalystOptions,
): Promise<Produced<Claim[]>> {
  const user = [
    `Question: ${question}`,
    `Lessons from earlier runs (may be outdated; only today's data counts as evidence):\n${memoryContext.trim() || "none"}`,
    `Query results:\n${formatResults(results)}`,
  ].join("\n\n");
  const answer = await opts.llm({ agent: AGENT, system: PROPOSE_SYSTEM, user, maxTokens: 2000 });
  const fromModel = answer ? parseClaims(answer.text) : [];

  if (answer && fromModel.length > 0) {
    opts.tracer.log({
      agent_name: AGENT,
      action: "propose_claims",
      status: "success",
      target_agent: "EvidenceCritic",
      model: answer.model,
      input_summary: `${results.length} query results; question: ${question}`,
      output_summary: `${fromModel.length} claims: ${fromModel.map((c) => c.statement).join(" | ")}`,
    });
    return { value: fromModel, model: answer.model };
  }

  const claims = deterministicClaims(results);
  opts.tracer.log({
    agent_name: AGENT,
    action: "propose_claims",
    status: "fallback",
    target_agent: "EvidenceCritic",
    model: null,
    input_summary: `${results.length} query results; question: ${question}`,
    output_summary: `${answer ? `Model ${answer.model} reply had no valid claims` : "No model available"}: ${claims.length} deterministic best-vs-worst claims`,
  });
  return { value: claims, model: null };
}

/**
 * Deterministic repair: replace cited values with the actual ones and recompute every statement
 * number from the same derivation. Returns null when the claim cannot be repaired (unknown
 * query/segment/metric, overreach, or a statement number that never matched the evidence).
 */
export function repairClaim(claim: Claim, verdict: Verdict): Claim | null {
  if (verdict.checks.some((c) => c.actual === null)) return null;
  if (verdict.reasons.some((r) => r.startsWith("Overreach"))) return null;
  const cited = verdict.checks.map((c) => c.cited);
  const actual = verdict.checks.map((c) => c.actual!);

  let statement = claim.statement;
  // Right to left so earlier positions stay valid while replacing.
  for (const n of extractNumbers(claim.statement).reverse()) {
    if (explain(n, actual)) continue; // already right; only the citation was off
    const derivation = explain(n, cited);
    if (!derivation) return null;
    const fixed = formatNumber(derivation.compute(actual), n.kind, n.decimals);
    statement = statement.slice(0, n.start) + fixed + statement.slice(n.end);
  }
  return { ...claim, statement, evidence: claim.evidence.map((e, i) => ({ ...e, value: actual[i]! })) };
}

export async function reviseClaims(
  rejected: readonly { claim: Claim; verdict: Verdict }[],
  results: readonly QueryResult[],
  opts: AnalystOptions & { round: number },
): Promise<Produced<Claim[]>> {
  const ids = new Set(rejected.map((r) => r.claim.id));
  const payload = rejected.map(({ claim, verdict }) => ({
    id: claim.id,
    statement: claim.statement,
    evidence: claim.evidence,
    critic_reasons: verdict.reasons,
    actual_values: verdict.checks.map((c) => ({ query: c.query, segment: c.segment, metric: c.metric, cited: c.cited, actual: c.actual })),
  }));
  const user = `Rejected claims:\n${JSON.stringify(payload)}\n\nQuery results:\n${formatResults(results)}`;
  const answer = await opts.llm({ agent: AGENT, system: REVISE_SYSTEM, user, maxTokens: 1500 });
  const fromModel = answer ? parseClaims(answer.text, ids) : [];

  let claims: Claim[];
  let model: string | null;
  if (answer && fromModel.length > 0) {
    claims = fromModel;
    model = answer.model;
  } else {
    claims = rejected.map((r) => repairClaim(r.claim, r.verdict)).filter((c): c is Claim => c !== null);
    model = null;
  }
  const dropped = [...ids].filter((id) => !claims.some((c) => c.id === id));
  opts.tracer.log({
    agent_name: AGENT,
    action: "revise_claims",
    status: model ? "success" : "fallback",
    target_agent: "EvidenceCritic",
    model,
    retry_count: opts.round,
    input_summary: `${rejected.length} rejected claims: ${[...ids].join(", ")}`,
    output_summary:
      `${model ? "" : `${answer ? `Model ${answer.model} reply unusable` : "No model available"}: deterministic repair with actual values. `}` +
      `${claims.length} revised${dropped.length ? `, dropped ${dropped.join(", ")}` : ""}`,
  });
  return { value: claims, model };
}
