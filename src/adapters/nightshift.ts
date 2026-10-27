// Meterless Nightshift adapter (OpenAI-compatible): the only module that calls the model provider.
// Agents never see this; they get the Llm port from src/adapters/llm.ts.
import { getConfig, normaliseMeterlessBaseUrl, redact, type Config } from "../config.ts";

export type NightshiftErrorKind =
  | "config" // no runtime token
  | "unreachable" // network error: Nightshift not running / wrong URL
  | "timeout"
  | "unauthorized" // 401/403: bad token, not "offline"
  | "rate_limited" // 429 after retries
  | "http" // other non-2xx
  | "invalid_response"; // 2xx we cannot use

const HINTS: Partial<Record<NightshiftErrorKind, string>> = {
  config: "Set METERLESS_RUNTIME_TOKEN in .env.",
  unreachable: "Is Meterless Nightshift running? Check METERLESS_BASE_URL (default http://127.0.0.1:8088/v1).",
  unauthorized: "Nightshift rejected the runtime token. Check METERLESS_RUNTIME_TOKEN in .env.",
  timeout: "Nightshift is reachable but the model did not answer in time.",
  rate_limited: "Nightshift kept answering 429 (rate limited). Retry later.",
};

export class NightshiftError extends Error {
  readonly kind: NightshiftErrorKind;
  readonly status: number | undefined;
  /** Provider error text (redacted, truncated). */
  readonly detail: string | undefined;
  readonly retryable: boolean;
  readonly hint: string | undefined;

  constructor(kind: NightshiftErrorKind, message: string, extra: { status?: number; detail?: string; retryable?: boolean } = {}) {
    super(message);
    this.name = "NightshiftError";
    this.kind = kind;
    this.status = extra.status;
    this.detail = extra.detail;
    this.retryable = extra.retryable ?? false;
    this.hint = HINTS[kind];
  }

  toJSON() {
    return { error: "nightshift", kind: this.kind, message: this.message, status: this.status, detail: this.detail };
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  /** The model that actually answered (meterless.routed_model), not the one requested. */
  model: string;
  requestedModel: string;
  attempts: number;
  ms: number;
}

export interface NightshiftOptions {
  config?: Config;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_MAX_TOKENS = 2000;
const DEFAULT_TIMEOUT_MS = 120_000;
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000];
const RETRY_STATUSES = new Set([429, 502]);
const MAX_DETAIL = 500;

interface Ctx {
  baseUrl: string;
  headers: Record<string, string>;
  secrets: readonly string[];
  timeoutMs: number;
  doFetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

function context(options: NightshiftOptions): Ctx {
  const config = options.config ?? getConfig();
  const token = config.meterless.runtimeToken;
  if (!token) throw new NightshiftError("config", "No Meterless runtime token configured (METERLESS_RUNTIME_TOKEN)");
  return {
    // Config already normalises; done again so a hand-built Config can't skip it.
    baseUrl: normaliseMeterlessBaseUrl(config.meterless.baseUrl),
    headers: {
      Authorization: `Bearer ${token}`,
      "meterless-app": "growthloop",
      "meterless-scope": "user",
      "Content-Type": "application/json",
    },
    secrets: [...config.secrets, token],
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    doFetch: options.fetch ?? fetch,
    sleep: options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
  };
}

function extractDetail(text: string, secrets: readonly string[]): string | undefined {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.startsWith("<")) return undefined;
  let detail = trimmed;
  try {
    const body = JSON.parse(trimmed) as Record<string, unknown>;
    // OpenAI style: {"error":{"message":"..."}}; also accept flat {"message"} / {"error":"..."}.
    const err = body.error;
    const message =
      typeof err === "object" && err !== null ? (err as Record<string, unknown>).message : typeof err === "string" ? err : body.message;
    if (typeof message === "string" && message.trim()) detail = message.trim();
  } catch {
    // Plain-text body: use as is.
  }
  const safe = redact(detail, secrets);
  return safe.length > MAX_DETAIL ? `${safe.slice(0, MAX_DETAIL)}...` : safe;
}

/** One HTTP request with timeout and the shared error mapping. Returns the parsed JSON body. */
async function request(ctx: Ctx, path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<Record<string, unknown>> {
  const url = `${ctx.baseUrl}${path}`;
  let status: number;
  let text: string;
  try {
    const response = await ctx.doFetch(url, {
      method: init.method,
      headers: ctx.headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(ctx.timeoutMs),
    });
    status = response.status;
    text = await response.text();
  } catch (err) {
    const name = (err as Error | undefined)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new NightshiftError("timeout", `Nightshift did not answer within ${ctx.timeoutMs / 1000} s`, { retryable: true });
    }
    const code = (err as { cause?: { code?: unknown } } | undefined)?.cause?.code;
    throw new NightshiftError("unreachable", `Cannot reach Nightshift at ${url}${typeof code === "string" ? ` (${code})` : ""}`);
  }

  const detail = extractDetail(text, ctx.secrets);
  if (status === 401 || status === 403) {
    throw new NightshiftError("unauthorized", `Nightshift returned HTTP ${status} (unauthorized)`, { status, detail });
  }
  if (status < 200 || status >= 300) {
    const kind = status === 429 ? "rate_limited" : "http";
    throw new NightshiftError(kind, `Nightshift returned HTTP ${status}${detail ? `: ${detail}` : ""}`, {
      status,
      detail,
      retryable: RETRY_STATUSES.has(status),
    });
  }
  try {
    const body = JSON.parse(text) as unknown;
    if (body !== null && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // Fall through.
  }
  throw new NightshiftError("invalid_response", "Nightshift returned a response that is not a JSON object", { status });
}

/** GET /v1/models: discovery. 401/403 means "unauthorized", not "offline". */
export async function listModels(options: NightshiftOptions = {}): Promise<string[]> {
  const ctx = context(options);
  const body = await request(ctx, "/models", { method: "GET" });
  if (!Array.isArray(body.data)) throw new NightshiftError("invalid_response", "GET /models returned no data array");
  return body.data
    .map((m) => (m && typeof m === "object" ? (m as Record<string, unknown>).id : undefined))
    .filter((id): id is string => typeof id === "string");
}

export interface ChatOptions extends NightshiftOptions {
  model?: string;
  maxTokens?: number;
}

/** POST /v1/chat/completions. Retries 429/502/timeout after 2, 4 and 8 s. */
export async function chat(messages: readonly ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
  const ctx = context(options);
  const requestedModel = options.model ?? (options.config ?? getConfig()).meterless.model;
  const body = {
    model: requestedModel,
    // Must be the first system message: tells reasoning models to skip their thinking phase.
    messages: [{ role: "system", content: "/no_think" }, ...messages],
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: false,
  };

  const started = performance.now();
  for (let n = 0; ; n++) {
    try {
      const response = await request(ctx, "/chat/completions", { method: "POST", body });
      const choices = response.choices;
      const first = Array.isArray(choices) ? (choices[0] as Record<string, unknown> | undefined) : undefined;
      const content = (first?.message as Record<string, unknown> | undefined)?.content;
      if (typeof content !== "string" || content.trim() === "") {
        throw new NightshiftError("invalid_response", "Nightshift reply has no message content");
      }
      // Log what actually answered: Nightshift may route meterless/auto to any provider.
      const routed = (response.meterless as Record<string, unknown> | undefined)?.routed_model;
      const model = typeof routed === "string" && routed ? routed : typeof response.model === "string" && response.model ? response.model : requestedModel;
      return { text: content, model, requestedModel, attempts: n + 1, ms: Math.round(performance.now() - started) };
    } catch (err) {
      if (!(err instanceof NightshiftError) || !err.retryable || n >= RETRY_DELAYS_MS.length) throw err;
      await ctx.sleep(RETRY_DELAYS_MS[n]!);
    }
  }
}
