// Response contract shared with the backend (POST /run). Keep in sync with the server.

export type Mode = "analyze" | "full";

export interface RunRequest {
  client: string;
  mode: Mode;
  question: string;
  period: { start: string; end: string };
}

export interface Evidence {
  query: string;
  segment: string;
  metric: string;
  value: number | string;
}

export interface Insight {
  id: string;
  statement: string;
  evidence: Evidence[];
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

export interface Draft {
  slot: number | string;
  platform: string;
  format: string;
  language: string;
  post_hour: number;
  caption: string;
  hashtags: string[];
}

export interface RunOutput {
  summary: string;
  insights: Insight[];
  rejected: RejectedClaim[];
  recommendations: Recommendation[];
  plan: PlanSlot[];
  drafts?: Draft[];
  outbox_file?: string;
}

export interface RecalledMemory {
  id: string;
  content: string;
  relevance: number;
}

export type TraceStatus = "success" | "needs_revision" | "rejected" | "fallback" | "error" | "info";

export interface TraceEvent {
  timestamp: string;
  agent_name: string;
  action: string;
  // Non-LLM steps (queries, rule checks, dry-run writes) have no target or model.
  target_agent: string | null;
  model: string | null;
  status: TraceStatus;
  output_summary: string;
  retry_count: number;
}

export interface RunResponse {
  run_id: string;
  status: string;
  execution_time_seconds: number;
  source: "zetaris" | "sample";
  output: RunOutput;
  memory: { recalled: RecalledMemory[]; stored: number };
  data_quality: { total_posts: number; valid_posts: number; invalid_posts: number };
  models: string[];
  trace: TraceEvent[];
}
