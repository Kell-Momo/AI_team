// Agent data shapes. They match the API contract in frontend/src/types.ts
// (Insight = an approved Claim; RejectedClaim = { claim: {id, statement}, reasons }).

export interface Evidence {
  /** Catalogue query id, e.g. "format_performance". */
  query: string;
  /** Row key in that query's result: segment, promo code or post id ("all" for data_quality). */
  segment: string;
  /** Column name in that query's result. */
  metric: string;
  value: number;
}

export interface Claim {
  id: string;
  statement: string;
  /** evidence[0] is the winning segment the claim is about. */
  evidence: Evidence[];
}

export interface EvidenceCheck {
  query: string;
  segment: string;
  metric: string;
  cited: number;
  /** The value in the query result, or null when the query/segment/metric does not exist. */
  actual: number | null;
  ok: boolean;
}

export interface Verdict {
  claim_id: string;
  approved: boolean;
  reasons: string[];
  checks: EvidenceCheck[];
}

export interface RejectedClaim {
  claim: { id: string; statement: string };
  reasons: string[];
}

export interface Recommendation {
  action: string;
  why: string;
  claim_ids: string[];
}

export interface PlanSlot {
  day: string;
  platform: string;
  format: string;
  pillar: string;
  language: string;
  post_hour: number;
  angle: string;
  promo_code?: string;
}

export interface Strategy {
  summary: string;
  recommendations: Recommendation[];
  plan: PlanSlot[];
}

export interface Draft {
  slot: number;
  platform: string;
  format: string;
  language: string;
  post_hour: number;
  caption: string;
  hashtags: string[];
}

export interface BrandReview {
  slot: number;
  approved: boolean;
  issues: string[];
}

/** Which model produced an agent's output; null = deterministic fallback. */
export interface Produced<T> {
  value: T;
  model: string | null;
}
