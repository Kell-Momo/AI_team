// One GrowthLoop run: recall -> data -> claims -> critique loop -> strategy -> [content] -> learn.
// The response type is imported from the frontend so the compiler enforces the shared contract.
import type { Insight, RejectedClaim, RunRequest, RunResponse, TraceEvent as ContractTraceEvent } from "../frontend/src/types.ts";
import { getConfig, type Config } from "./config.ts";
import { createTracer, type Tracer } from "./trace.ts";
import { createLlm, type RunLlm } from "./adapters/llm.ts";
import { runSql } from "./adapters/zetaris.ts";
import { MarketingMemory } from "./engines/memory.ts";
import { loadSampleData, type SampleData } from "./analytics/sample.ts";
import { getQuery } from "./analytics/queries.ts";
import type { QueryDeps, QueryResult } from "./analytics/source.ts";
import { gatherData, proposeClaims, reviseClaims } from "./agents/analyst.ts";
import { MIN_POSTS, reviewClaims } from "./agents/critic.ts";
import { planWeek } from "./agents/strategist.ts";
import { createDrafts, publishDryRun, reviewDrafts, reviseDrafts } from "./agents/content.ts";
import type { Lesson, Llm } from "./agents/ports.ts";
import type { Claim, Draft, Strategy, Verdict } from "./agents/types.ts";

const ORCHESTRATOR = "Orchestrator";
const MEMORY_KEEPER = "MemoryKeeper";
const MAX_CRITIQUE_REVISIONS = 2;
const MAX_QUESTION = 500;
const MAX_MEMORY_TEXT = 600;

// ---------- input validation (CLAUDE.md rules) ----------

export class ValidationError extends Error {
  readonly code = "invalid_input";
  constructor(readonly details: string[]) {
    super(`Invalid input: ${details.join("; ")}`);
    this.name = "ValidationError";
  }
}

export class RunBusyError extends Error {
  readonly code = "run_in_progress";
  constructor(client: string) {
    super(`A run for client "${client}" is already in progress. Try again when it has finished.`);
    this.name = "RunBusyError";
  }
}

const CLIENT_SLUG = /^[a-z0-9-]{2,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FIELDS = ["client", "mode", "question", "period"];
const isRealDate = (d: string) => DATE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);

export function validateInput(raw: unknown): RunRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError(["Body must be a JSON object"]);
  const r = raw as Record<string, unknown>;
  const issues: string[] = [];
  for (const key of Object.keys(r)) if (!FIELDS.includes(key)) issues.push(`Unknown field "${key}"`);

  const client = r.client;
  if (typeof client !== "string" || !CLIENT_SLUG.test(client)) issues.push("client must match ^[a-z0-9-]{2,40}$");
  const mode = r.mode;
  if (mode !== "analyze" && mode !== "full") issues.push('mode must be "analyze" or "full"');
  const question = typeof r.question === "string" ? r.question.trim() : null;
  if (question === null || question === "") issues.push("question must be a non-empty string");
  else if (question.length > MAX_QUESTION) issues.push(`question must be at most ${MAX_QUESTION} characters`);

  const period = r.period;
  let start = "";
  let end = "";
  if (!period || typeof period !== "object" || Array.isArray(period)) {
    issues.push("period must be an object {start, end}");
  } else {
    const p = period as Record<string, unknown>;
    for (const key of Object.keys(p)) if (key !== "start" && key !== "end") issues.push(`Unknown field "period.${key}"`);
    start = typeof p.start === "string" ? p.start : "";
    end = typeof p.end === "string" ? p.end : "";
    if (!isRealDate(start)) issues.push("period.start must be a real date YYYY-MM-DD");
    if (!isRealDate(end)) issues.push("period.end must be a real date YYYY-MM-DD");
    if (isRealDate(start) && isRealDate(end) && start > end) issues.push("period.start must be on or before period.end");
  }

  if (issues.length > 0) throw new ValidationError(issues);
  return { client: client as string, mode: mode as RunRequest["mode"], question: question!, period: { start, end } };
}

// ---------- run ----------

export interface RunDeps {
  config?: Config;
  /** Preloaded sample tables (tests); otherwise read from config.paths.data in SAMPLE_MODE. */
  sampleData?: SampleData;
  createLlm?: (tracer: Tracer, config: Config) => RunLlm;
  runSql?: (sql: string) => Promise<unknown[]>;
  /** Where readable trace lines go (the CLI sends them to stderr to keep stdout pure JSON). */
  traceOut?: (line: string) => void;
}

// One run per client at a time: two runs would race on .memory/<client>/state.json.
const activeClients = new Set<string>();

export async function run(raw: unknown, deps: RunDeps = {}): Promise<RunResponse> {
  const input = validateInput(raw);
  // Checked and taken synchronously, before any await, so two requests cannot both pass.
  if (activeClients.has(input.client)) throw new RunBusyError(input.client);
  activeClients.add(input.client);
  try {
    return await execute(input, deps);
  } finally {
    activeClients.delete(input.client);
  }
}

async function execute(input: RunRequest, deps: RunDeps): Promise<RunResponse> {
  const config = deps.config ?? getConfig();
  const started = performance.now();
  const source = config.sampleMode ? "sample" : "zetaris";
  const tracer = createTracer({
    logsDir: config.paths.logs,
    secrets: config.secrets,
    logLevel: config.logLevel,
    ...(deps.traceOut ? { stdout: deps.traceOut } : {}),
  });
  const { client, mode, question, period } = input;

  tracer.log({
    agent_name: ORCHESTRATOR,
    action: "start_run",
    status: "info",
    input_summary: `${client}, mode ${mode}, ${period.start}..${period.end}: ${question}`,
    output_summary: `data source: ${source === "sample" ? "local sample CSVs (SAMPLE_MODE)" : `Zetaris ${config.zetaris.usl}`}`,
  });

  const llm = (deps.createLlm ?? ((t, c) => createLlm({ tracer: t, config: c })))(tracer, config);
  const memory = new MarketingMemory({ client, rootDir: config.paths.memory });
  const finish: Finish = (status, body) => {
    const seconds = Math.round((performance.now() - started) / 100) / 10;
    tracer.log({
      agent_name: ORCHESTRATOR,
      action: "finish_run",
      status: status === "completed" ? "success" : "error",
      output_summary:
        `${status} in ${seconds} s: ${body.output.insights.length} insights, ${body.output.rejected.length} rejected, ` +
        `${body.memory.stored} memories stored; models: ${llm.models().join(", ") || "none (deterministic fallbacks)"}`,
    });
    const response: RunResponse = {
      run_id: tracer.runId,
      status,
      execution_time_seconds: seconds,
      source,
      ...body,
      models: llm.models(),
      trace: tracer.events().map(toContractEvent),
    };
    return response;
  };

  try {
    return await steps(input, deps, config, tracer, llm, memory, finish);
  } catch (err) {
    tracer.log({ agent_name: ORCHESTRATOR, action: "finish_run", status: "error", output_summary: `run aborted: ${err instanceof Error ? err.message : String(err)}` });
    throw new RunFailedError(tracer.runId, err);
  }
}

/** Unexpected failure inside a run; the trace file has the details. */
export class RunFailedError extends Error {
  readonly code = "run_failed";
  constructor(
    readonly runId: string,
    override readonly cause: unknown,
  ) {
    super(`Run ${runId} failed unexpectedly; see logs/trace-${runId}.jsonl`);
    this.name = "RunFailedError";
  }
}

type Finish = (
  status: string,
  body: Omit<RunResponse, "run_id" | "status" | "execution_time_seconds" | "source" | "models" | "trace">,
) => RunResponse;

async function steps(input: RunRequest, deps: RunDeps, config: Config, tracer: Tracer, llm: RunLlm, memory: MarketingMemory, finish: Finish): Promise<RunResponse> {
  const { client, mode, question, period } = input;
  const source = config.sampleMode ? "sample" : "zetaris";

  // 1. Recall what earlier runs learned for this client.
  const recalled = memory.recall(question);
  const top = recalled.lessons[0];
  tracer.log({
    agent_name: MEMORY_KEEPER,
    action: "recall_lessons",
    status: "success",
    target_agent: "DataAnalyst",
    input_summary: question,
    output_summary: top
      ? `Recalled ${recalled.lessons.length} lessons for ${client} (top relevance ${top.relevance}): ${recalled.lessons.map((l) => l.id).join(", ")}`
      : `No lessons yet for ${client}: first run starts from the data alone`,
  });

  // 2. Data, only through the fixed catalogue (Zetaris, or the sample tables in SAMPLE_MODE).
  let sampleData: SampleData | undefined;
  if (config.sampleMode) {
    try {
      sampleData = deps.sampleData ?? loadSampleData(config.paths.data);
    } catch (err) {
      tracer.log({ agent_name: "DataAnalyst", action: "load_sample_data", status: "error", output_summary: err instanceof Error ? err.message : String(err) });
      return finish("failed", emptyBody("No data: the sample CSVs could not be loaded (see trace).", recalled.lessons));
    }
  }
  const queryDeps: QueryDeps = {
    sampleMode: config.sampleMode,
    usl: config.zetaris.usl,
    sampleData,
    runSql: deps.runSql ?? (async (sql) => (await runSql(sql, { config })).rows),
  };
  const results = await gatherData(period, queryDeps, tracer);
  const dataQuality = readDataQuality(results);
  if (!results.some((r) => getQuery(r.id)?.segmentQuery)) {
    return finish("failed", {
      ...emptyBody(`No data: the ${source === "sample" ? "sample" : "Zetaris"} queries returned nothing usable (see trace).`, recalled.lessons),
      data_quality: dataQuality,
    });
  }

  // 3. Claims and the critique loop.
  const proposed = await proposeClaims(question, results, recalled.context, { llm, tracer });
  const { approved, rejected } = await critique(proposed.value, results, llm, tracer);

  // 4. Strategy.
  const promoRows = results.find((r) => r.id === "promo_roi")?.rows ?? [];
  const promoCodes = new Set(promoRows.map((r) => String(r.promo_code)));
  const strategy = await planWeek(question, approved, recalled.context, recalled.lessons.length, promoCodes, {
    llm,
    tracer,
    nextAgent: mode === "full" ? "ContentCreator" : MEMORY_KEEPER,
  });

  // 5. Content (full mode): drafts, brand review with one revision, dry-run outbox.
  let drafts: Draft[] | undefined;
  let outboxFile: string | undefined;
  if (mode === "full") {
    const plan = strategy.value.plan;
    let current = (await createDrafts(plan, { llm, tracer })).value;
    let reviews = await reviewDrafts(current, { llm, tracer, round: 0 });
    if (reviews.some((r) => !r.approved)) {
      current = (await reviseDrafts(current, reviews, plan, { llm, tracer })).value;
      reviews = await reviewDrafts(current, { llm, tracer, round: 1 });
    }
    outboxFile = publishDryRun({ runId: tracer.runId, client, drafts: current, reviews, outboxDir: config.paths.outbox, tracer }).file;
    const ok = new Set(reviews.filter((r) => r.approved).map((r) => r.slot));
    // Only drafts the BrandReviewer approved are returned; blocked ones are listed in the outbox file.
    drafts = current.filter((d) => ok.has(d.slot));
  }

  // 6. Learn.
  const stored = learn(memory, recalled.lessons, approved, results, strategy.value, input, tracer);

  return finish("completed", {
    output: {
      summary: strategy.value.summary,
      insights: approved.map(toInsight),
      rejected,
      recommendations: strategy.value.recommendations,
      plan: strategy.value.plan,
      ...(drafts ? { drafts } : {}),
      ...(outboxFile ? { outbox_file: outboxFile } : {}),
    },
    memory: { recalled: recalled.lessons.map(({ id, content, relevance }) => ({ id, content, relevance })), stored },
    data_quality: dataQuality,
  });
}

// ---------- steps ----------

/** Review -> revise, at most MAX_CRITIQUE_REVISIONS revisions; what still fails is rejected. */
async function critique(claims: Claim[], results: readonly QueryResult[], llm: Llm, tracer: Tracer) {
  const approved: Claim[] = [];
  const rejected: RejectedClaim[] = [];
  let pending = claims;
  for (let round = 0; pending.length > 0; round++) {
    const final = round === MAX_CRITIQUE_REVISIONS;
    const verdicts = await reviewClaims(pending, results, { llm, tracer, round, final });
    const failing: { claim: Claim; verdict: Verdict }[] = [];
    pending.forEach((claim, i) => (verdicts[i]!.approved ? approved.push(claim) : failing.push({ claim, verdict: verdicts[i]! })));
    if (failing.length === 0) break;
    if (final) {
      rejected.push(...failing.map(({ claim, verdict }) => ({ claim: { id: claim.id, statement: claim.statement }, reasons: verdict.reasons })));
      break;
    }
    const revised = (await reviseClaims(failing, results, { llm, tracer, round: round + 1 })).value;
    for (const { claim, verdict } of failing) {
      if (!revised.some((c) => c.id === claim.id)) {
        rejected.push({
          claim: { id: claim.id, statement: claim.statement },
          reasons: [...verdict.reasons, "Dropped by DataAnalyst: it could not be revised to match the data."],
        });
      }
    }
    pending = revised;
  }
  return { approved, rejected };
}

/** Today's winning segment of a query, by the same rule the analyst uses for its claims. */
export function winningSegment(result: QueryResult): string | null {
  const spec = getQuery(result.id);
  if (!spec || spec.keyColumn === null) return null;
  const metric = spec.primaryMetric;
  const rows = result.rows.filter(
    (r) => typeof r[metric] === "number" && (!spec.segmentQuery || (typeof r.posts === "number" && r.posts >= MIN_POSTS)),
  );
  const best = [...rows].sort((a, b) => (b[metric] as number) - (a[metric] as number))[0];
  return best ? String(best[spec.keyColumn]) : null;
}

const tagValue = (tags: readonly string[], prefix: string) => tags.find((t) => t.startsWith(prefix))?.slice(prefix.length);
const clip = (s: string) => (s.length > MAX_MEMORY_TEXT ? `${s.slice(0, MAX_MEMORY_TEXT - 3)}...` : s);

function learn(
  memory: MarketingMemory,
  lessons: readonly Lesson[],
  approved: readonly Claim[],
  results: readonly QueryResult[],
  strategy: Strategy,
  input: RunRequest,
  tracer: Tracer,
): number {
  // Feedback first: today's data judges the recalled lessons, before today's insights are added.
  for (const lesson of lessons) {
    const query = tagValue(lesson.tags, "q:");
    const best = tagValue(lesson.tags, "best:");
    if (!query || !best) continue; // decisions carry no testable claim
    const result = results.find((r) => r.id === query);
    const today = result ? winningSegment(result) : null;
    if (!today) {
      tracer.log({
        agent_name: MEMORY_KEEPER,
        action: "feedback",
        status: "info",
        input_summary: `${lesson.id}: ${lesson.content}`,
        output_summary: `no feedback: ${query} has no eligible winner in today's data`,
      });
      continue;
    }
    const kind = today.toLowerCase() === best.toLowerCase() ? "helpful" : "not_helpful";
    memory.feedback(lesson.id, kind);
    tracer.log({
      agent_name: MEMORY_KEEPER,
      action: "feedback",
      status: "success",
      input_summary: `${lesson.id}: ${lesson.content}`,
      output_summary: `${kind}: lesson says the best ${query} segment is "${best}"; today's winner is "${today}"`,
    });
  }

  let stored = 0;
  const period = `${input.period.start} to ${input.period.end}`;
  for (const claim of approved) {
    const ev = claim.evidence[0];
    if (!ev) continue;
    const content = clip(`${claim.statement} (period ${period})`);
    const existing = memory.findByContent(content);
    if (existing) {
      tracer.log({ agent_name: MEMORY_KEEPER, action: "store_insight", status: "info", input_summary: claim.id, output_summary: `already in memory as ${existing}` });
      continue;
    }
    const id = memory.rememberInsight(content, [`q:${ev.query}`, `best:${ev.segment}`], tracer.runId);
    stored++;
    tracer.log({
      agent_name: MEMORY_KEEPER,
      action: "store_insight",
      status: "success",
      input_summary: `${claim.id}: ${claim.statement}`,
      output_summary: `stored as ${id} (tags q:${ev.query}, best:${ev.segment})`,
    });
  }

  const decision = clip(
    `Decision for ${period} (${input.mode}): ${strategy.summary} Actions: ${strategy.recommendations.map((r) => r.action).join(" ")}`,
  );
  const existing = memory.findByContent(decision);
  if (existing) {
    tracer.log({ agent_name: MEMORY_KEEPER, action: "store_decision", status: "info", output_summary: `already in memory as ${existing}` });
  } else {
    const id = memory.rememberDecision(decision, tracer.runId);
    stored++;
    tracer.log({ agent_name: MEMORY_KEEPER, action: "store_decision", status: "success", output_summary: `stored decision summary as ${id}` });
  }
  return stored;
}

// ---------- shaping ----------

function readDataQuality(results: readonly QueryResult[]): RunResponse["data_quality"] {
  const row = results.find((r) => r.id === "data_quality")?.rows[0];
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  return { total_posts: n(row?.total_posts), valid_posts: n(row?.valid_posts), invalid_posts: n(row?.invalid_posts) };
}

function emptyBody(summary: string, lessons: readonly Lesson[]) {
  return {
    output: { summary, insights: [], rejected: [], recommendations: [], plan: [] },
    memory: { recalled: lessons.map(({ id, content, relevance }) => ({ id, content, relevance })), stored: 0 },
    data_quality: { total_posts: 0, valid_posts: 0, invalid_posts: 0 },
  };
}

const toInsight = (c: Claim): Insight => ({ id: c.id, statement: c.statement, evidence: c.evidence.map((e) => ({ ...e })) });

const toContractEvent = (e: ReturnType<Tracer["events"]>[number]): ContractTraceEvent => ({
  timestamp: e.timestamp,
  agent_name: e.agent_name,
  action: e.action,
  target_agent: e.target_agent,
  model: e.model,
  status: e.status,
  output_summary: e.output_summary,
  retry_count: e.retry_count,
});
