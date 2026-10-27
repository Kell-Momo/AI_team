import { useEffect, useRef, type ReactNode } from "react";
import { formatDuration, formatHour, formatMetricValue, LANGUAGE_NAMES, percent } from "../format";
import type { Mode, RunResponse } from "../types";
import { Timeline } from "./Timeline";

const lang = (code: string) => LANGUAGE_NAMES[code] ?? code;

export function ResultView({ result, mode }: { result: RunResponse; mode: Mode }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Move focus to the results so keyboard and screen-reader users land on them.
  useEffect(() => headingRef.current?.focus(), [result]);

  const { output, memory, data_quality: dq } = result;

  return (
    <div className="results">
      {/* 1. Header */}
      <section className="card run-header" aria-labelledby="run-title">
        <div className="run-title-row">
          <h2 id="run-title" ref={headingRef} tabIndex={-1}>
            Run results
          </h2>
          <span className={`badge ${result.source === "zetaris" ? "badge-zetaris" : "badge-sample"}`}>
            {result.source === "zetaris" ? "Zetaris" : "Sample mode"}
          </span>
        </div>
        <dl className="meta">
          <div>
            <dt>Run id</dt>
            <dd className="mono">{result.run_id}</dd>
          </div>
          <div>
            <dt>Duration</dt>
            <dd>{formatDuration(result.execution_time_seconds)}</dd>
          </div>
          <div>
            <dt>Models via Nightshift</dt>
            <dd>
              {result.models.length > 0 ? (
                <ul className="inline-list">
                  {result.models.map((m) => (
                    <li key={m} className="tag mono">{m}</li>
                  ))}
                </ul>
              ) : (
                <span className="tag tag-fallback">deterministic fallback</span>
              )}
            </dd>
          </div>
        </dl>
        {output.summary && <p className="summary">{output.summary}</p>}
      </section>

      {/* 2. Memory recalled */}
      <Section id="recalled" title="What the team remembered" count={memory.recalled.length}>
        {memory.recalled.length === 0 ? (
          <Empty>First audit: no memory yet</Empty>
        ) : (
          <ul className="stack">
            {memory.recalled.map((m) => (
              <li key={m.id} className="memory-item">
                <p>{m.content}</p>
                <div className="relevance">
                  <span className="meter" aria-hidden="true">
                    <span style={{ width: `${Math.round(Math.min(1, Math.max(0, m.relevance)) * 100)}%` }} />
                  </span>
                  <span className="muted small">
                    Relevance {m.relevance.toFixed(2)} · <span className="mono">{m.id}</span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* 3. Verified insights */}
      <Section id="insights" title="Verified insights" count={output.insights.length}>
        {output.insights.length === 0 ? (
          <Empty>No claim passed the EvidenceCritic this run.</Empty>
        ) : (
          <div className="cards">
            {output.insights.map((ins) => (
              <article key={ins.id} id={`claim-${ins.id}`} className="insight">
                <div className="insight-head">
                  <span className="verified">✓ verified by EvidenceCritic</span>
                  <span className="mono muted small">{ins.id}</span>
                </div>
                <p className="statement">{ins.statement}</p>
                <div className="table-scroll">
                  <table className="evidence">
                    <caption className="sr-only">Evidence for {ins.id}</caption>
                    <thead>
                      <tr>
                        <th scope="col">Query</th>
                        <th scope="col">Segment</th>
                        <th scope="col">Metric</th>
                        <th scope="col" className="num">Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ins.evidence.map((ev, i) => (
                        <tr key={i}>
                          <td className="mono">{ev.query}</td>
                          <td className="mono">{ev.segment}</td>
                          <td className="mono">{ev.metric}</td>
                          <td className="num">{formatMetricValue(ev.metric, ev.value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>
            ))}
          </div>
        )}
      </Section>

      {/* 4. Rejected */}
      <Section id="rejected" title="Rejected by the Critic" count={output.rejected.length}>
        {output.rejected.length === 0 ? (
          <Empty>Every claim held up against the data.</Empty>
        ) : (
          <ul className="stack">
            {output.rejected.map((r) => (
              <li key={r.claim.id} className="rejected">
                <p className="statement">
                  <span className="x" aria-hidden="true">✕</span> <s>{r.claim.statement}</s>
                  <span className="mono muted small"> {r.claim.id}</span>
                </p>
                <ul className="reasons">
                  {r.reasons.map((reason, i) => (
                    <li key={i}>{reason}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* 5. Recommendations + plan */}
      <Section id="recs" title="Recommendations" count={output.recommendations.length}>
        <ol className="recs">
          {output.recommendations.map((r, i) => (
            <li key={i}>
              <p className="rec-action">{r.action}</p>
              <p className="muted">{r.why}</p>
              {r.claim_ids.length > 0 && (
                <p className="small">
                  Based on{" "}
                  {r.claim_ids.map((id) => (
                    <a key={id} href={`#claim-${id}`} className="tag mono">
                      {id}
                    </a>
                  ))}
                </p>
              )}
            </li>
          ))}
        </ol>

        <h3 className="sub">Next week's plan</h3>
        {output.plan.length === 0 ? (
          <Empty>No plan this run.</Empty>
        ) : (
          <div className="table-scroll">
            <table className="plan">
              <thead>
                <tr>
                  <th scope="col">Day</th>
                  <th scope="col">Platform</th>
                  <th scope="col">Format</th>
                  <th scope="col">Pillar</th>
                  <th scope="col">Language</th>
                  <th scope="col">Time</th>
                  <th scope="col">Angle</th>
                  <th scope="col">Promo</th>
                </tr>
              </thead>
              <tbody>
                {output.plan.map((p, i) => (
                  <tr key={i}>
                    <th scope="row">{p.day}</th>
                    <td className="cap">{p.platform}</td>
                    <td className="cap">{p.format}</td>
                    <td className="cap">{p.pillar}</td>
                    <td>{lang(p.language)}</td>
                    <td className="mono">{formatHour(p.post_hour)}</td>
                    <td className="angle">{p.angle}</td>
                    <td>{p.promo_code ? <span className="tag mono">{p.promo_code}</span> : <span className="muted">–</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* 6. Drafts (full mode only) */}
      {mode === "full" && (
        <Section id="drafts" title="Drafts" count={output.drafts?.length ?? 0} badge={<span className="badge badge-dry">Dry run: not published</span>}>
          {output.outbox_file && (
            <p className="small muted">
              Written to outbox: <span className="mono">{output.outbox_file}</span>
            </p>
          )}
          {!output.drafts?.length ? (
            <Empty>No drafts were produced.</Empty>
          ) : (
            <div className="cards drafts">
              {output.drafts.map((d) => (
                <article key={String(d.slot)} className="draft">
                  <div className="draft-head">
                    <span className="cap">
                      Slot {d.slot} · {d.platform} {d.format}
                    </span>
                    <span className="muted small">
                      {lang(d.language)} · {formatHour(d.post_hour)}
                    </span>
                  </div>
                  <p className="caption">{d.caption}</p>
                  <p className="hashtags">{d.hashtags.join(" ")}</p>
                  <p className={`small ${d.caption.length > 280 ? "over" : "muted"}`}>{d.caption.length}/280 characters</p>
                </article>
              ))}
            </div>
          )}
        </Section>
      )}

      {/* 7. Data quality */}
      <Section id="dq" title="Data quality">
        <p>
          <strong>
            {dq.invalid_posts} of {dq.total_posts} posts
          </strong>{" "}
          excluded by the <span className="mono">valid_metrics</span> rule ({percent(dq.invalid_posts, dq.total_posts)}).
          The agents analysed the remaining {dq.valid_posts}.
        </p>
        <div
          className="dq-bar"
          role="img"
          aria-label={`${dq.valid_posts} valid posts, ${dq.invalid_posts} excluded`}
        >
          <span className="dq-valid" style={{ flexGrow: dq.valid_posts }} />
          <span className="dq-invalid" style={{ flexGrow: dq.invalid_posts }} />
        </div>
        <p className="small muted">Rule: reach &gt; 0 and engagements ≤ reach (Zetaris data-quality check).</p>
      </Section>

      {/* 8. Timeline */}
      <Timeline events={result.trace} />

      {/* 9. Memory stored */}
      <Section id="stored" title="Saved to memory this run">
        <p>
          {memory.stored > 0 ? (
            <>
              <strong>{memory.stored}</strong> Critic-approved {memory.stored === 1 ? "lesson" : "lessons"} saved to H-MEM.
              The next run starts from here.
            </>
          ) : (
            "Nothing new saved this run."
          )}
        </p>
      </Section>
    </div>
  );
}

function Section(props: { id: string; title: string; count?: number; badge?: ReactNode; children: ReactNode }) {
  return (
    <section className="card" aria-labelledby={`${props.id}-title`}>
      <div className="section-head">
        <h2 id={`${props.id}-title`}>
          {props.title}
          {props.count !== undefined && <span className="count">{props.count}</span>}
        </h2>
        {props.badge}
      </div>
      {props.children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
