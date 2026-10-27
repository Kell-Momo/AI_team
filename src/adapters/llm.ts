// Implements the agents' Llm port on top of Nightshift. Returns null whenever no model can
// answer, so each agent runs its deterministic fallback and the trace says "fallback".
import { getConfig, type Config } from "../config.ts";
import type { Llm, LlmRequest } from "../agents/ports.ts";
import type { Tracer } from "../trace.ts";
import { chat as nightshiftChat, NightshiftError, type ChatOptions } from "./nightshift.ts";

// Failures that will not fix themselves within one run. Timeout is included because each one
// already cost up to 4 x 120 s of retries; repeating that for every agent would stall the run.
const BREAKER_KINDS = new Set(["config", "unreachable", "unauthorized", "timeout"]);

export interface LlmOptions {
  tracer: Tracer;
  config?: Config;
  /** Injectable for tests. */
  chat?: typeof nightshiftChat;
  chatOptions?: Omit<ChatOptions, "config" | "maxTokens">;
}

export interface RunLlm extends Llm {
  /** Distinct models that actually answered during this run. */
  readonly models: () => string[];
}

/** One instance per run: the circuit breaker and the model list are per run. */
export function createLlm(options: LlmOptions): RunLlm {
  const config = options.config ?? getConfig();
  const chat = options.chat ?? nightshiftChat;
  const models = new Set<string>();
  let openReason: string | null = config.sampleMode ? "SAMPLE_MODE: no model calls" : null;

  const fallback = (req: LlmRequest, why: string) => {
    options.tracer.log({
      agent_name: req.agent,
      action: "llm_call",
      status: "fallback",
      target_agent: "Nightshift",
      input_summary: `${req.agent} prompt, ${req.system.length + req.user.length} chars`,
      output_summary: `${why}; deterministic fallback`,
    });
    return null;
  };

  const complete = async (req: LlmRequest) => {
    if (openReason) return fallback(req, openReason);
    try {
      const result = await chat(
        [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        { ...options.chatOptions, config, maxTokens: req.maxTokens },
      );
      models.add(result.model);
      options.tracer.log({
        agent_name: req.agent,
        action: "llm_call",
        status: "success",
        target_agent: "Nightshift",
        model: result.model,
        retry_count: result.attempts - 1,
        input_summary: `${req.agent} prompt, ${req.system.length + req.user.length} chars (requested ${result.requestedModel})`,
        output_summary: `${result.text.length} chars from ${result.model} in ${result.ms} ms`,
      });
      return { text: result.text, model: result.model };
    } catch (err) {
      if (!(err instanceof NightshiftError)) throw err;
      if (BREAKER_KINDS.has(err.kind)) {
        openReason = `Nightshift ${err.kind} (${err.message}); circuit open for the rest of this run`;
        return fallback(req, openReason);
      }
      // Transient or per-request (429 after retries, 5xx, bad reply): this call falls back, later ones still try.
      return fallback(req, `Nightshift ${err.kind}: ${err.message}`);
    }
  };

  return Object.assign(complete, { models: () => [...models] });
}
