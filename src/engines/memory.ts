// MarketingMemory: per-client long-term memory on the vendored Meterless H-MEM reference.
// One H-MEM store per client in .memory/<client>/ (state.json + ledger.jsonl), so lessons
// learned for one business never leak into another's runs.
import { join, resolve } from "node:path";
import type { FeedbackKind, HMEMOptions, MemoryRecord, Provenance, QueryResult } from "../../vendor/hmem/types.ts";
import type { Lesson, MemoryPort } from "../agents/ports.ts";

// Minimal surface of the vendored HMEM class that we use.
interface HmemInstance {
  add(input: {
    content: string;
    type?: MemoryRecord["type"];
    layer?: MemoryRecord["layer"];
    tags?: string[];
    confidence?: number;
    source: string;
    provenance?: Provenance;
  }): MemoryRecord;
  query(query: string, opts?: { topN?: number; threshold?: number }): QueryResult;
  feedback(memoryId: string, kind: FeedbackKind): void;
  readonly store: { get(id: string): MemoryRecord | undefined; all(): MemoryRecord[] };
}

// Loaded through a computed specifier so our strict tsconfig doesn't type-check the vendored
// sources (kept byte-identical to upstream); `npm run typecheck` checks them with upstream's options.
const HMEM_MODULE = new URL("../../vendor/hmem/index.ts", import.meta.url).href;
const { HMEM } = (await import(HMEM_MODULE)) as { HMEM: new (opts: HMEMOptions) => HmemInstance };

const CLIENT_SLUG = /^[a-z0-9-]{2,40}$/;
// H-MEM's default 0.35 assumes a real embedder. With the reference's hash embedder, a lesson
// scores only ~0.13-0.19 against a paraphrased question (measured on our insight texts). The
// store holds only this client's lessons, so recall = H-MEM's top N above a low floor; lessons
// whose confidence was driven down by "wrong" feedback still drop out through the multiplier.
const RECALL_THRESHOLD = 0.05;
const RECALL_TOP_N = 6;
const INSIGHT_CONFIDENCE = 0.7;
const DECISION_CONFIDENCE = 0.6;

export interface MarketingMemoryOptions {
  client: string;
  /** Parent folder; the store lives in <rootDir>/<client>/. */
  rootDir: string;
  clock?: () => number;
}

export class MarketingMemory implements MemoryPort {
  readonly client: string;
  readonly dir: string;
  private readonly hmem: HmemInstance;
  private readonly clock: () => number;

  constructor(options: MarketingMemoryOptions) {
    // The slug becomes a folder name: validate it here too, not only at the HTTP edge.
    if (!CLIENT_SLUG.test(options.client)) throw new Error(`Invalid client slug: ${options.client}`);
    this.client = options.client;
    this.dir = resolve(join(options.rootDir, options.client));
    this.clock = options.clock ?? Date.now;
    this.hmem = new HMEM({ persistDir: this.dir, actor: "growthloop", clock: this.clock });
  }

  recall(question: string): { lessons: Lesson[]; context: string } {
    const result = this.hmem.query(question, { topN: RECALL_TOP_N, threshold: RECALL_THRESHOLD });
    return {
      lessons: result.memories.map(({ memory, relevance }) => ({
        id: memory.id,
        content: memory.content,
        relevance: Math.round(relevance * 10_000) / 10_000,
        tags: [...memory.tags],
      })),
      context: result.context,
    };
  }

  rememberInsight(content: string, tags: string[], runId: string): string {
    return this.add(content, "factual", ["kind:insight", ...tags], INSIGHT_CONFIDENCE, runId, "EvidenceCritic-approved insight");
  }

  rememberDecision(content: string, runId: string): string {
    return this.add(content, "general", ["kind:decision"], DECISION_CONFIDENCE, runId, "Strategist decision summary");
  }

  feedback(id: string, kind: "helpful" | "not_helpful" | "wrong"): void {
    this.hmem.feedback(id, kind);
  }

  /** Read-only view of one memory (for tests and the API's memory panel). */
  get(id: string): { id: string; content: string; confidence: number; tags: string[] } | undefined {
    const m = this.hmem.store.get(id);
    return m && { id: m.id, content: m.content, confidence: m.confidence, tags: [...m.tags] };
  }

  /** Id of a memory with exactly this content, so re-running the same analysis doesn't duplicate lessons. */
  findByContent(content: string): string | undefined {
    return this.hmem.store.all().find((m) => m.content === content)?.id;
  }

  size(): number {
    return this.hmem.store.all().length;
  }

  private add(content: string, type: MemoryRecord["type"], tags: string[], confidence: number, runId: string, label: string): string {
    const record = this.hmem.add({
      content,
      type,
      layer: "working",
      // No project:<client> tag: it would pin the domain to the client name, which a question
      // (always classified "general") never matches, costing every lesson H-MEM's domain term.
      tags,
      confidence,
      source: `growthloop:${runId}`,
      provenance: { origin: "plan_completion", learnedAt: this.clock(), label: `${label}, run ${runId}`, refs: [runId] },
    });
    return record.id;
  }
}
