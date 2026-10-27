import { useEffect, useRef, useState } from "react";
import { ApiError, checkHealth, runAgents, runMock } from "./api";
import { DEFAULT_FORM, RunForm, validate, type FormState } from "./components/RunForm";
import { ResultView } from "./components/ResultView";
import type { Mode, RunRequest, RunResponse } from "./types";

const MOCK_PREF_KEY = "growthloop.useMock";

type Phase =
  | { kind: "idle" }
  | { kind: "running"; startedAt: number }
  | { kind: "done"; result: RunResponse; mode: Mode }
  | { kind: "error"; error: ApiError };

// Mock stays on by default until the backend is ready; the choice is remembered per browser.
function readMockPref(): boolean {
  try {
    return localStorage.getItem(MOCK_PREF_KEY) !== "false";
  } catch {
    return true;
  }
}

export function App() {
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [useMock, setUseMock] = useState(readMockPref);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [showErrors, setShowErrors] = useState(false);
  const [backendUp, setBackendUp] = useState<boolean | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    checkHealth().then(setBackendUp);
  }, []);

  function toggleMock(v: boolean) {
    setUseMock(v);
    try {
      localStorage.setItem(MOCK_PREF_KEY, String(v));
    } catch {
      /* storage blocked: preference just won't persist */
    }
  }

  async function submit() {
    setShowErrors(true);
    if (Object.keys(validate(form)).length > 0) return;

    const req: RunRequest = {
      client: form.client,
      mode: form.mode,
      question: form.question.trim(),
      period: { start: form.start, end: form.end },
    };
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase({ kind: "running", startedAt: Date.now() });
    try {
      const result = await (useMock ? runMock : runAgents)(req, ctrl.signal);
      setPhase({ kind: "done", result, mode: req.mode });
    } catch (err) {
      const error = err instanceof ApiError ? err : new ApiError("Something went wrong in the browser.");
      setPhase({ kind: "error", error });
    } finally {
      abortRef.current = null;
    }
  }

  return (
    <>
      <header className="site-header">
        <div className="wrap header-inner">
          <div className="brand">
            <span className="logo" aria-hidden="true">
              <svg viewBox="0 0 32 32" width="32" height="32">
                <rect width="32" height="32" rx="8" fill="currentColor" />
                <path d="M9 20a7 7 0 1 1 7 7" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
                <path d="M16 27l-3-3 3-3" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <div>
              <h1>GrowthLoop</h1>
              <p className="tagline">Your AI marketing team: audits, learns, plans</p>
            </div>
          </div>
          <BackendStatus up={backendUp} />
        </div>
      </header>

      <main className="wrap">
        <RunForm
          value={form}
          onChange={setForm}
          onSubmit={submit}
          busy={phase.kind === "running"}
          useMock={useMock}
          onToggleMock={toggleMock}
          showErrors={showErrors}
        />

        <div aria-live="polite">
          {phase.kind === "running" && (
            <Progress startedAt={phase.startedAt} mock={useMock} onCancel={() => abortRef.current?.abort()} />
          )}
        </div>
        {phase.kind === "error" && <ErrorBox error={phase.error} />}
        {phase.kind === "done" && <ResultView result={phase.result} mode={phase.mode} />}
      </main>

      <footer className="wrap site-footer">
        GrowthLoop · Saveurs de Douala data is synthetic · Publishing is dry-run only
      </footer>
    </>
  );
}

function BackendStatus({ up }: { up: boolean | null }) {
  if (up === null) return null;
  return (
    <span className={`status-dot ${up ? "ok" : "off"}`}>
      Backend {up ? "online" : "offline"}
    </span>
  );
}

function Progress({ startedAt, mock, onCancel }: { startedAt: number; mock: boolean; onCancel: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.floor((now - startedAt) / 1000);
  return (
    <section className="card progress" role="status">
      <span className="spinner" aria-hidden="true" />
      <div>
        <p className="progress-title">Agents working… 1-3 minutes</p>
        <p className="muted">
          {mock ? "Mock data: " : ""}DataAnalyst, EvidenceCritic and Strategist are on it. Elapsed {secs}s.
        </p>
      </div>
      <button type="button" className="ghost" onClick={onCancel}>
        Cancel
      </button>
    </section>
  );
}

function ErrorBox({ error }: { error: ApiError }) {
  return (
    <section className="card error-box" role="alert">
      <h2>Run failed</h2>
      <p>{error.message}</p>
      {(error.code || error.status) && (
        <p className="muted mono">
          {[error.status && `HTTP ${error.status}`, error.code].filter(Boolean).join(" · ")}
        </p>
      )}
      {error.details.length > 0 && (
        <ul>
          {error.details.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
