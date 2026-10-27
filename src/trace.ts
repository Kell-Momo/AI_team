// Run trace: one JSONL file per run (the record judges read) + readable lines on stdout.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { LOG_LEVELS, redact, type LogLevel } from "./config.ts";

export const TRACE_STATUSES = ["success", "needs_revision", "rejected", "fallback", "error", "info"] as const;
export type TraceStatus = (typeof TRACE_STATUSES)[number];

export interface TraceEvent {
  timestamp: string;
  run_id: string;
  agent_name: string;
  action: string;
  input_summary: string;
  output_summary: string;
  target_agent: string | null;
  model: string | null;
  retry_count: number;
  status: TraceStatus;
}

/** What callers pass; the tracer fills timestamp/run_id and defaults. */
export interface TraceInput {
  agent_name: string;
  action: string;
  status: TraceStatus;
  input_summary?: string;
  output_summary?: string;
  target_agent?: string | null;
  model?: string | null;
  retry_count?: number;
}

export interface TracerOptions {
  logsDir: string;
  runId?: string;
  secrets?: readonly string[];
  /** Filters stdout only; the JSONL file always gets every event. */
  logLevel?: LogLevel;
  /** Injectable for tests. */
  now?: () => Date;
  stdout?: (line: string) => void;
}

export interface Tracer {
  readonly runId: string;
  readonly filePath: string;
  log(input: TraceInput): TraceEvent;
  events(): readonly TraceEvent[];
}

// Summaries, not payloads: keeps traces readable and avoids dumping raw business data.
const MAX_SUMMARY = 400;
// run_id becomes part of a file name, so restrict it to prevent path traversal.
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

const STATUS_LEVEL: Record<TraceStatus, LogLevel> = {
  success: "info",
  info: "info",
  needs_revision: "warn",
  rejected: "warn",
  fallback: "warn",
  error: "error",
};

export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

function truncate(s: string): string {
  return s.length > MAX_SUMMARY ? `${s.slice(0, MAX_SUMMARY - 3)}...` : s;
}

export function formatTraceLine(e: TraceEvent): string {
  const time = e.timestamp.slice(11, 19);
  const target = e.target_agent ? ` -> ${e.target_agent}` : "";
  const meta = [e.model ? `model=${e.model}` : "", e.retry_count > 0 ? `retries=${e.retry_count}` : ""]
    .filter(Boolean)
    .join(", ");
  const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
  const parts = [`${time} ${e.agent_name}.${e.action}${target} [${e.status}]${meta ? ` (${meta})` : ""}`];
  if (e.input_summary) parts.push(`in: ${oneLine(e.input_summary)}`);
  if (e.output_summary) parts.push(`out: ${oneLine(e.output_summary)}`);
  return parts.join(" | ");
}

export function createTracer(options: TracerOptions): Tracer {
  const now = options.now ?? (() => new Date());
  const runId = options.runId ?? newRunId(now());
  if (!RUN_ID_PATTERN.test(runId)) throw new Error(`Invalid run_id: must match ${RUN_ID_PATTERN}`);

  const secrets = options.secrets ?? [];
  const minLevel = LOG_LEVELS.indexOf(options.logLevel ?? "info");
  const stdout = options.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const filePath = join(options.logsDir, `trace-${runId}.jsonl`);
  const recorded: TraceEvent[] = [];

  mkdirSync(options.logsDir, { recursive: true });

  return {
    runId,
    filePath,
    log(input) {
      // Validate at runtime too: statuses come from agent code paths we want to keep honest.
      if (!(TRACE_STATUSES as readonly string[]).includes(input.status)) {
        throw new Error(`Invalid trace status: ${String(input.status)}`);
      }
      const retryCount = input.retry_count ?? 0;
      if (!Number.isInteger(retryCount) || retryCount < 0) throw new Error("retry_count must be a non-negative integer");

      const event = redact(
        {
          timestamp: now().toISOString(),
          run_id: runId,
          agent_name: input.agent_name,
          action: input.action,
          input_summary: truncate(input.input_summary ?? ""),
          output_summary: truncate(input.output_summary ?? ""),
          target_agent: input.target_agent ?? null,
          model: input.model ?? null,
          retry_count: retryCount,
          status: input.status,
        } satisfies TraceEvent,
        secrets,
      ) as TraceEvent;

      // Sync append keeps lines ordered and on disk even if the process dies mid-run.
      appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
      recorded.push(event);
      if (LOG_LEVELS.indexOf(STATUS_LEVEL[event.status]) >= minLevel) stdout(formatTraceLine(event));
      return event;
    },
    events() {
      return [...recorded];
    },
  };
}
