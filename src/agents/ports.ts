// What agents need from the outside world, injected as parameters so agents stay testable
// and independent of the Nightshift / H-MEM adapters.

export interface LlmRequest {
  /** Agent name, for routing and logs. */
  agent: string;
  system: string;
  user: string;
  maxTokens?: number;
}

/** Returns null when no model is available: the caller must use its deterministic fallback. */
export type Llm = (req: LlmRequest) => Promise<{ text: string; model: string } | null>;

export interface Lesson {
  id: string;
  content: string;
  relevance: number;
  tags: string[];
}

export interface MemoryPort {
  recall(question: string): { lessons: Lesson[]; context: string };
  /** Returns the new memory id. */
  rememberInsight(content: string, tags: string[], runId: string): string;
  rememberDecision(content: string, runId: string): string;
  feedback(id: string, kind: "helpful" | "not_helpful" | "wrong"): void;
}

/** An Llm that never answers: every agent runs its deterministic fallback. */
export const noLlm: Llm = async () => null;

/**
 * Strictly parse model output as JSON: the first ```json fence if present, otherwise the
 * first balanced {...} or [...] in the text. JSON.parse only (never eval); null on failure.
 * The shape is NOT validated here: callers must check every field.
 */
export function parseJson<T = unknown>(text: string): T | null {
  if (typeof text !== "string") return null;
  // Reasoning models may emit <think> blocks even with /no_think; their braces are not the answer.
  const s = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const fence = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(s);
  const candidates = fence ? [fence[1]!, s] : [s];
  for (const candidate of candidates) {
    const json = firstBalanced(candidate);
    if (json === null) continue;
    try {
      return JSON.parse(json) as T;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

// String-aware bracket matching, so braces inside JSON strings do not end the value early.
function firstBalanced(s: string): string | null {
  const start = s.search(/[{[]/);
  if (start === -1) return null;
  const stack: string[] = [];
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return null;
      if (stack.length === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
