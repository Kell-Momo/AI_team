// EvidenceCritic: deterministic number checks first (a model can never approve a wrong
// number), then an optional LLM review that can only reject for overreach.
import { getQuery } from "../analytics/queries.ts";
import type { QueryResult } from "../analytics/source.ts";
import type { Tracer } from "../trace.ts";
import { close, explain, extractNumbers } from "./numbers.ts";
import { parseJson, type Llm } from "./ports.ts";
import type { Claim, EvidenceCheck, Verdict } from "./types.ts";

export const AGENT = "EvidenceCritic";
export const MIN_POSTS = 3;

const CAUSAL =
  /\b(caus(?:e|es|ed|ing)|drives?|drove|driving|leads? to|led to|because|results? in|resulted in|proves?|guarantee[sd]?|entra[iî]ne|provoque|gr[aâ]ce [aà]|garanti[es]*)\b/i;
const SALES = /\b(sales|revenue|orders?|profit\w*|roas|ventes?|chiffre d'affaires|commandes?)\b|FCFA|XAF/i;

export interface CriticOptions {
  llm: Llm;
  tracer: Tracer;
  /** 0 for the first review, 1.. for reviews of revised claims. */
  round: number;
  /** Last allowed round: rejected claims are final (status "rejected") instead of going back. */
  final: boolean;
}

// Accepts "reel", "Reel" and "format=reel" for the same row key.
const normaliseKey = (s: string) => s.trim().toLowerCase().replace(/^[a-z_]+\s*=\s*/, "");

function findRow(result: QueryResult, segment: string) {
  const spec = getQuery(result.id);
  if (!spec) return undefined;
  if (spec.keyColumn === null) return result.rows[0];
  const key = normaliseKey(segment);
  return result.rows.find((r) => normaliseKey(String(r[spec.keyColumn!])) === key);
}

/** Pure deterministic review of one claim. */
export function checkClaim(claim: Claim, results: readonly QueryResult[]): Verdict {
  const reasons: string[] = [];
  const checks: EvidenceCheck[] = [];
  const byId = new Map(results.map((r) => [r.id as string, r]));

  if (claim.evidence.length === 0) reasons.push("No evidence cited.");

  for (const ev of claim.evidence) {
    const where = `${ev.query} / ${ev.segment} / ${ev.metric}`;
    const result = byId.get(ev.query);
    const spec = getQuery(ev.query);
    let actual: number | null = null;
    if (!result || !spec) {
      reasons.push(`Unknown query "${ev.query}" (not in the catalogue results of this run).`);
    } else {
      const row = findRow(result, ev.segment);
      if (!row) {
        reasons.push(`Unknown segment "${ev.segment}" in ${ev.query}.`);
      } else if (!spec.columns.includes(ev.metric) || ev.metric === spec.keyColumn || typeof row[ev.metric] !== "number") {
        reasons.push(`Unknown or non-numeric metric "${ev.metric}" in ${ev.query}.`);
      } else {
        actual = row[ev.metric] as number;
        if (!close(ev.value, actual)) reasons.push(`${where}: cited ${ev.value}, actual ${actual}.`);
        if (spec.segmentQuery && typeof row.posts === "number" && row.posts < MIN_POSTS) {
          reasons.push(`Overreach: segment "${ev.segment}" in ${ev.query} has only ${row.posts} posts (minimum ${MIN_POSTS}).`);
        }
      }
    }
    checks.push({ ...ev, cited: ev.value, actual, ok: actual !== null && close(ev.value, actual) });
  }

  // Statement numbers are explained by the true values, so a number copied from a wrong citation fails too.
  const values = checks.map((c) => c.actual ?? c.cited);
  for (const num of extractNumbers(claim.statement)) {
    if (!explain(num, values)) {
      const raw = claim.statement.slice(num.start, num.end);
      reasons.push(`Number "${raw}" in the statement matches no evidence value or ratio of two (3% tolerance).`);
    }
  }

  if (CAUSAL.test(claim.statement)) {
    reasons.push("Overreach: causal wording; the data only shows an association.");
  }
  if (SALES.test(claim.statement) && !claim.evidence.some((e) => e.query === "promo_roi")) {
    reasons.push("Overreach: talks about sales or revenue but cites engagement data only.");
  }

  return { claim_id: claim.id, approved: reasons.length === 0, reasons, checks };
}

const REVIEW_SYSTEM = [
  "You are EvidenceCritic in GrowthLoop, a marketing team for a small food business in Douala.",
  "The numbers in these claims were already verified against the data. Your only job is to flag OVERREACH:",
  "- causal conclusions (X causes / drives Y) when the data only shows an association;",
  "- conclusions about sales, revenue or profit drawn from engagement data only;",
  `- generalising from small samples (segments with fewer than ${MIN_POSTS} posts);`,
  "- statements about things the cited evidence does not cover.",
  "Do not re-check arithmetic. Be strict but fair: plain comparisons of measured averages are fine.",
  'Reply with JSON only: {"reviews":[{"id":"c1","overreach":false,"reason":""}]}',
].join("\n");

async function llmOverreach(
  llm: Llm,
  claims: Claim[],
  results: readonly QueryResult[],
): Promise<{ flagged: Map<string, string>; model: string | null; usable: boolean }> {
  const postsOf = (query: string, segment: string) => {
    const result = results.find((r) => r.id === query);
    const row = result && findRow(result, segment);
    return typeof row?.posts === "number" ? row.posts : undefined;
  };
  const payload = claims.map((c) => ({
    id: c.id,
    statement: c.statement,
    evidence: c.evidence.map((e) => ({ ...e, posts: postsOf(e.query, e.segment) })),
  }));
  const answer = await llm({ agent: AGENT, system: REVIEW_SYSTEM, user: JSON.stringify({ claims: payload }), maxTokens: 1200 });
  if (!answer) return { flagged: new Map(), model: null, usable: false };

  const parsed = parseJson<{ reviews?: unknown }>(answer.text);
  if (!parsed || !Array.isArray(parsed.reviews)) return { flagged: new Map(), model: answer.model, usable: false };
  const ids = new Set(claims.map((c) => c.id));
  const flagged = new Map<string, string>();
  for (const r of parsed.reviews as Record<string, unknown>[]) {
    if (r && typeof r.id === "string" && ids.has(r.id) && r.overreach === true) {
      const reason = typeof r.reason === "string" && r.reason.trim() ? r.reason.trim().slice(0, 300) : "no reason given";
      flagged.set(r.id, `Overreach (model review): ${reason}`);
    }
  }
  return { flagged, model: answer.model, usable: true };
}

/** Review every claim; logs one trace event per claim plus the model review. */
export async function reviewClaims(
  claims: Claim[],
  results: readonly QueryResult[],
  opts: CriticOptions,
): Promise<Verdict[]> {
  const verdicts = claims.map((c) => checkClaim(c, results));
  const passed = claims.filter((_, i) => verdicts[i]!.approved);

  let model: string | null = null;
  if (passed.length > 0) {
    const review = await llmOverreach(opts.llm, passed, results);
    model = review.model;
    opts.tracer.log({
      agent_name: AGENT,
      action: "overreach_review",
      status: review.usable ? "success" : "fallback",
      model: review.model,
      retry_count: opts.round,
      input_summary: `${passed.length} claims that passed the number checks`,
      output_summary: review.usable
        ? `${review.flagged.size} flagged as overreach`
        : review.model
          ? "Model reply was not valid JSON: deterministic checks only"
          : "No model available: deterministic checks only",
    });
    for (const v of verdicts) {
      const reason = review.flagged.get(v.claim_id);
      if (reason) {
        v.approved = false;
        v.reasons.push(reason);
      }
    }
  }

  claims.forEach((claim, i) => {
    const v = verdicts[i]!;
    opts.tracer.log({
      agent_name: AGENT,
      action: "verify_claim",
      status: v.approved ? "success" : opts.final ? "rejected" : "needs_revision",
      target_agent: v.approved ? "Strategist" : opts.final ? null : "DataAnalyst",
      model: v.reasons.some((r) => r.startsWith("Overreach (model review)")) ? model : null,
      retry_count: opts.round,
      input_summary: `${claim.id}: ${claim.statement}`,
      output_summary: v.approved ? "approved: every number matches the query results" : v.reasons.join(" "),
    });
  });
  return verdicts;
}
