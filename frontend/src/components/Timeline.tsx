import { formatTime } from "../format";
import type { TraceEvent, TraceStatus } from "../types";

const STATUS_LABEL: Record<TraceStatus, string> = {
  success: "success",
  needs_revision: "needs revision",
  rejected: "rejected",
  fallback: "fallback",
  error: "error",
  info: "info",
};

export function Timeline({ events }: { events: TraceEvent[] }) {
  const retries = events.filter((e) => e.status === "needs_revision" || e.status === "rejected").length;
  return (
    <section className="card" aria-labelledby="timeline-title">
      <details className="timeline">
        <summary>
          <h2 id="timeline-title">
            Agent timeline<span className="count">{events.length}</span>
          </h2>
          <span className="muted small">
            {retries > 0 ? `${retries} critique ${retries === 1 ? "step" : "steps"} · ` : ""}click to expand
          </span>
        </summary>
        <ol className="events">
          {events.map((e, i) => (
            <li key={i} className={`event st-${e.status}`}>
              <span className="event-dot" aria-hidden="true" />
              <div className="event-body">
                <div className="event-line">
                  <span className="agent">{e.agent_name}</span>
                  {e.target_agent && (
                    <>
                      <span className="arrow" aria-label="to">→</span>
                      <span className="agent">{e.target_agent}</span>
                    </>
                  )}
                  <span className="action mono">{e.action}</span>
                  <span className={`pill st-${e.status}`}>{STATUS_LABEL[e.status] ?? e.status}</span>
                  {e.retry_count > 0 && <span className="pill pill-retry">retry {e.retry_count}</span>}
                </div>
                <p className="event-summary">{e.output_summary}</p>
                <p className="small muted">
                  <time dateTime={e.timestamp}>{formatTime(e.timestamp)}</time>
                  {" · "}
                  <span className="mono">{e.model ?? (e.status === "fallback" ? "deterministic fallback" : "no model (rules / query)")}</span>
                </p>
              </div>
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
