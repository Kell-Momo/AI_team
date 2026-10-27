import mock from "./mock.json";
import type { RunRequest, RunResponse } from "./types";

// Agents take 1-3 minutes; give up well after that so the UI never hangs forever.
const RUN_TIMEOUT_MS = 5 * 60 * 1000;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function runAgents(req: RunRequest, signal: AbortSignal): Promise<RunResponse> {
  const timeout = AbortSignal.timeout(RUN_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch("/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(req),
      signal: AbortSignal.any([signal, timeout]),
    });
  } catch {
    if (signal.aborted) throw new ApiError("Run cancelled.", undefined, "cancelled");
    if (timeout.aborted) throw new ApiError("The run took longer than 5 minutes and was stopped.", undefined, "timeout");
    throw unreachable();
  }

  const body: unknown = await res.json().catch(() => null);
  // The Vite dev proxy answers an empty 5xx when the backend is down; our server always sends JSON.
  if (!res.ok && body === null && res.status >= 500) throw unreachable(res.status);
  if (!res.ok) throw toApiError(res.status, body);
  if (!body || typeof body !== "object" || !("output" in body)) {
    throw new ApiError("The backend returned an unexpected response.", res.status, "bad_response");
  }
  return body as RunResponse;
}

function unreachable(status?: number): ApiError {
  return new ApiError(
    "Cannot reach the GrowthLoop backend. Is it running on port 8000? You can also switch on “Use mock data”.",
    status,
    "backend_unreachable",
  );
}

// Accepts the usual structured shapes: {error:{code,message,details}}, {error:"..."}, {message,code}.
function toApiError(status: number, body: unknown): ApiError {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const nested = b.error && typeof b.error === "object" ? (b.error as Record<string, unknown>) : undefined;
  const message =
    str(nested?.message) ?? str(b.message) ?? str(b.error) ?? `Request failed (HTTP ${status}).`;
  const code = str(nested?.code) ?? str(b.code);
  return new ApiError(message, status, code, toDetails(nested?.details ?? b.details));
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function toDetails(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((d) => (typeof d === "string" ? d : JSON.stringify(d)));
  if (v && typeof v === "object") return Object.entries(v).map(([k, d]) => `${k}: ${String(d)}`);
  return typeof v === "string" ? [v] : [];
}

// Mock run: same contract as the backend. In analyze mode the content agents never run,
// so we drop their drafts and trace events to keep the example honest.
export async function runMock(req: RunRequest, signal: AbortSignal): Promise<RunResponse> {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, 1500);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new ApiError("Run cancelled.", undefined, "cancelled"));
    });
  });
  const data = structuredClone(mock) as RunResponse;
  if (req.mode === "analyze") {
    const contentAgents = new Set(["ContentCreator", "BrandReviewer", "Publisher"]);
    delete data.output.drafts;
    delete data.output.outbox_file;
    data.trace = data.trace
      .filter((e) => !contentAgents.has(e.agent_name))
      .map((e) => (e.agent_name === "Strategist" ? { ...e, target_agent: "MemoryKeeper" } : e));
  }
  return data;
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch("/health", { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}
