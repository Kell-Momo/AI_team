// Runs one catalogue query against Zetaris, or against the in-memory sample tables in
// SAMPLE_MODE. Both paths return the same columns, so agents never know the difference.
import { toObjects } from "../adapters/zetaris.ts";
import { QueryError, type Period, type QueryId, type QuerySpec, type Row } from "./queries.ts";
import type { SampleData } from "./sample.ts";

export interface QueryResult {
  id: QueryId;
  title: string;
  source: "zetaris" | "sample";
  /** The statement (also shown in sample mode: it is what would run on Zetaris). */
  sql: string;
  rows: Row[];
  ms: number;
}

export interface QueryDeps {
  sampleMode: boolean;
  /** Runs one statement on Zetaris and returns the raw rows (arrays or objects). */
  runSql: (sql: string) => Promise<unknown[]>;
  usl: string;
  /** Required in sample mode; loaded once by the caller. */
  sampleData?: SampleData;
}

export async function runQuery(spec: QuerySpec, period: Period, deps: QueryDeps): Promise<QueryResult> {
  const started = performance.now();
  const sql = spec.sql(period, deps.usl);
  let rows: Row[];
  if (deps.sampleMode) {
    if (!deps.sampleData) throw new QueryError("SAMPLE_MODE needs the sample data");
    rows = spec.compute(deps.sampleData, period);
  } else {
    rows = toObjects(await deps.runSql(sql), spec.columns, { keepAsString: spec.textColumns });
  }
  return {
    id: spec.id,
    title: spec.title,
    source: deps.sampleMode ? "sample" : "zetaris",
    sql,
    rows,
    ms: Math.round(performance.now() - started),
  };
}
