import type { FormEvent, ReactNode } from "react";
import type { Mode } from "../types";

export interface FormState {
  client: string;
  mode: Mode;
  question: string;
  start: string;
  end: string;
}

export const QUESTION_MAX = 500;

export const DEFAULT_FORM: FormState = {
  client: "saveurs-de-douala",
  mode: "analyze",
  question: "Audit our existing content: which formats, hours and languages drive engagement and sales?",
  start: "2026-07-01",
  end: "2026-09-15",
};

const PRESETS: { label: string; patch: Partial<FormState> }[] = [
  {
    label: "Audit existing content",
    patch: {
      start: "2026-07-01",
      end: "2026-09-15",
      question: "Audit our existing content: which formats, hours and languages drive engagement and sales?",
    },
  },
  {
    label: "Compare app posts vs existing",
    patch: {
      start: "2026-07-01",
      end: "2026-10-20",
      question: "Compare the posts made with GrowthLoop against our existing content: what improved and what should change?",
    },
  },
];

// Mirrors the backend's input rules so most mistakes are caught before a 1-3 minute run.
export function validate(f: FormState): Partial<Record<keyof FormState, string>> {
  const errors: Partial<Record<keyof FormState, string>> = {};
  const date = /^\d{4}-\d{2}-\d{2}$/;
  if (!/^[a-z0-9-]{2,40}$/.test(f.client)) errors.client = "2-40 characters: lowercase letters, digits and hyphens.";
  if (!f.question.trim()) errors.question = "Ask the team a question.";
  else if (f.question.length > QUESTION_MAX) errors.question = `At most ${QUESTION_MAX} characters.`;
  if (!date.test(f.start)) errors.start = "Use the format YYYY-MM-DD.";
  if (!date.test(f.end)) errors.end = "Use the format YYYY-MM-DD.";
  else if (!errors.start && f.start > f.end) errors.end = "The end date must be on or after the start date.";
  return errors;
}

interface Props {
  value: FormState;
  onChange: (next: FormState) => void;
  onSubmit: () => void;
  busy: boolean;
  useMock: boolean;
  onToggleMock: (v: boolean) => void;
  showErrors: boolean;
}

export function RunForm({ value, onChange, onSubmit, busy, useMock, onToggleMock, showErrors }: Props) {
  const errors = showErrors ? validate(value) : {};
  const set = <K extends keyof FormState>(key: K, v: FormState[K]) => onChange({ ...value, [key]: v });

  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit();
  }

  return (
    <form className="card form" onSubmit={submit} noValidate aria-labelledby="form-title">
      <div className="form-head">
        <h2 id="form-title">Brief the team</h2>
        <label className="toggle">
          <input type="checkbox" checked={useMock} onChange={(e) => onToggleMock(e.target.checked)} disabled={busy} />
          <span>Use mock data</span>
        </label>
      </div>

      <div className="presets" role="group" aria-label="Presets">
        {PRESETS.map((p) => (
          <button key={p.label} type="button" className="chip-btn" disabled={busy} onClick={() => onChange({ ...value, ...p.patch })}>
            {p.label}
          </button>
        ))}
      </div>

      <div className="grid-2">
        <Field id="client" label="Client" error={errors.client}>
          <input
            id="client"
            value={value.client}
            onChange={(e) => set("client", e.target.value.trim())}
            autoComplete="off"
            spellCheck={false}
            maxLength={40}
            aria-invalid={!!errors.client}
            aria-describedby={errors.client ? "client-err" : undefined}
          />
        </Field>

        <fieldset className="field">
          <legend>Mode</legend>
          <div className="segmented">
            {(["analyze", "full"] as const).map((m) => (
              <label key={m} className={value.mode === m ? "on" : ""}>
                <input type="radio" name="mode" value={m} checked={value.mode === m} onChange={() => set("mode", m)} />
                {m === "analyze" ? "Analyze" : "Full (with drafts)"}
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <Field
        id="question"
        label="Question"
        error={errors.question}
        hint={
          <span className={value.question.length > QUESTION_MAX ? "over" : ""} id="question-count">
            {value.question.length}/{QUESTION_MAX}
          </span>
        }
      >
        <textarea
          id="question"
          rows={3}
          value={value.question}
          onChange={(e) => set("question", e.target.value)}
          maxLength={QUESTION_MAX}
          aria-invalid={!!errors.question}
          aria-describedby={["question-count", errors.question ? "question-err" : ""].join(" ").trim()}
        />
      </Field>

      <div className="grid-2">
        <Field id="start" label="Period start" error={errors.start}>
          <input id="start" type="date" value={value.start} onChange={(e) => set("start", e.target.value)} aria-invalid={!!errors.start} />
        </Field>
        <Field id="end" label="Period end" error={errors.end}>
          <input id="end" type="date" value={value.end} onChange={(e) => set("end", e.target.value)} aria-invalid={!!errors.end} />
        </Field>
      </div>

      <button type="submit" className="primary" disabled={busy}>
        {busy ? "Agents working…" : "Run the team"}
      </button>
    </form>
  );
}

function Field(props: { id: string; label: string; error?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <div className="label-row">
        <label htmlFor={props.id}>{props.label}</label>
        {props.hint}
      </div>
      {props.children}
      {props.error && (
        <p className="field-error" id={`${props.id}-err`}>
          {props.error}
        </p>
      )}
    </div>
  );
}
