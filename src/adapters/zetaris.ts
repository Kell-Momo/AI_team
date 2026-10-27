// Zetaris REST adapter: the only module that talks to Zetaris. Agents receive rows, never call fetch.
import { randomUUID } from "node:crypto";
import { getConfig, redact, type Config } from "../config.ts";

export type ZetarisErrorKind =
  | "config" // missing key / org id
  | "invalid_statement" // rejected locally before sending
  | "unreachable" // network error: Zetaris down or port not forwarded
  | "timeout"
  | "unauthorized" // 401/403
  | "sql" // Zetaris answered with an error about the statement
  | "http" // other non-2xx without a usable message
  | "invalid_response"; // 2xx we cannot interpret

const HINTS: Partial<Record<ZetarisErrorKind, string>> = {
  config: "Copy .env.example to .env and fill in ZETARIS_ORG_ID and ZETARIS_API_KEY.",
  unreachable:
    "Is the Codespace running and port 8888 forwarded to this machine (VS Code > Ports)? Check ZETARIS_REST_URL.",
  unauthorized: "Zetaris rejected the API key. Check the key and ZETARIS_ORG_ID in .env.",
  timeout: "Zetaris is reachable but slow; the driver may still be starting. Retry in a minute.",
};

export class ZetarisError extends Error {
  readonly kind: ZetarisErrorKind;
  readonly status: number | undefined;
  /** Zetaris's own error text (redacted, truncated). */
  readonly detail: string | undefined;
  readonly requestId: string | undefined;
  readonly retryable: boolean;
  readonly hint: string | undefined;

  constructor(
    kind: ZetarisErrorKind,
    message: string,
    extra: { status?: number; detail?: string; requestId?: string; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "ZetarisError";
    this.kind = kind;
    this.status = extra.status;
    this.detail = extra.detail;
    this.requestId = extra.requestId;
    this.retryable = extra.retryable ?? false;
    this.hint = HINTS[kind];
  }

  toJSON() {
    return { error: "zetaris", kind: this.kind, message: this.message, status: this.status, detail: this.detail };
  }
}

// COMPILE USL ... DDL is ONE statement whose CREATE TABLEs must be separated by ";" (Zetaris
// rejects newline-only separation as "Invalid DDL statement"). Only that ";" is allowed inside.
const USL_DDL = /^COMPILE\s+USL\b/i;
const NEXT_IS_CREATE_TABLE = /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*CREATE\s+TABLE\b/i;
const ONLY_TRAILING = /;|\s+|--[^\n]*|\/\*[\s\S]*?\*\//g;

/**
 * Zetaris runs exactly one statement per request. Trim, drop trailing semicolons and reject
 * anything that still contains a top-level `;`, except between the CREATE TABLEs of a
 * COMPILE USL DDL block. Newlines are kept: COMPILE USL needs them.
 */
export function normaliseStatement(sql: string): string {
  const s = sql.trim();
  const semicolons: number[] = [];
  let i = 0;
  // Skip over a quoted region; returns the index just past its closing quote.
  const skipQuoted = (quote: string, start: number): number => {
    for (let j = start + 1; j < s.length; j++) {
      if (s[j] === "\\") j++;
      else if (s[j] === quote) {
        if (s[j + 1] === quote) j++; // SQL-style doubled quote
        else return j + 1;
      }
    }
    throw new ZetarisError("invalid_statement", `Unterminated ${quote} quote in SQL`);
  };

  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuoted(ch, i);
    } else if (ch === "-" && s[i + 1] === "-") {
      const end = s.indexOf("\n", i);
      i = end === -1 ? s.length : end + 1;
    } else if (ch === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      if (end === -1) throw new ZetarisError("invalid_statement", "Unterminated /* comment in SQL");
      i = end + 2;
    } else if (ch === ";") {
      semicolons.push(i);
      i++;
    } else {
      i++;
    }
  }

  // Cut at the first semicolon after which only semicolons, whitespace and comments remain.
  const trailing = semicolons.find((pos) => s.slice(pos).replace(ONLY_TRAILING, "") === "");
  const statement = trailing === undefined ? s : s.slice(0, trailing).trimEnd();
  for (const pos of semicolons) {
    if (trailing !== undefined && pos >= trailing) break;
    if (!USL_DDL.test(statement) || !NEXT_IS_CREATE_TABLE.test(s.slice(pos + 1))) {
      throw new ZetarisError("invalid_statement", "Only one SQL statement per request is allowed");
    }
  }
  if (statement === "") throw new ZetarisError("invalid_statement", "Empty SQL statement");
  return statement;
}

export type Cell = string | number | boolean | null;

// Canonical decimals only: "007", "2026-07-01", "1e3" and "+5" stay strings.
const NUMERIC = /^-?(0|[1-9]\d*)(\.\d+)?$/;

function coerce(value: unknown, keepString: boolean, where: string): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "string") throw new ZetarisError("invalid_response", `${where}: unexpected value type ${typeof value}`);
  if (keepString || !NUMERIC.test(value)) return value;
  const n = Number(value);
  // Beyond 2^53 a number would silently lose digits; keep the exact string.
  return Number.isInteger(n) && !Number.isSafeInteger(n) ? value : n;
}

/**
 * Map Zetaris rows (arrays in column order, or objects keyed by column) to objects,
 * coercing numeric strings. Columns listed in keepAsString are never coerced.
 */
export function toObjects(
  rows: readonly unknown[],
  columns: readonly string[],
  options: { keepAsString?: readonly string[] } = {},
): Record<string, Cell>[] {
  const keep = new Set(options.keepAsString ?? []);
  return rows.map((row, i) => {
    const out: Record<string, Cell> = {};
    if (Array.isArray(row)) {
      // A width mismatch means the column order is wrong; mapping anyway would mislabel numbers.
      if (row.length !== columns.length) {
        throw new ZetarisError("invalid_response", `Row ${i} has ${row.length} values, expected ${columns.length}`);
      }
      columns.forEach((col, j) => (out[col] = coerce(row[j], keep.has(col), `row ${i}.${col}`)));
    } else if (row !== null && typeof row === "object") {
      const record = row as Record<string, unknown>;
      // Spark may change identifier case, so fall back to a case-insensitive match.
      const lower = new Map(Object.keys(record).map((k) => [k.toLowerCase(), k]));
      for (const col of columns) {
        const key = col in record ? col : lower.get(col.toLowerCase());
        if (key === undefined) throw new ZetarisError("invalid_response", `Row ${i} has no column ${col}`);
        out[col] = coerce(record[key], keep.has(col), `row ${i}.${col}`);
      }
    } else {
      throw new ZetarisError("invalid_response", `Row ${i} is neither an array nor an object`);
    }
    return out;
  });
}

export interface SqlResult {
  rows: unknown[];
  /** Column names, when the response carries them. */
  columns: string[] | null;
  requestId: string;
  attempts: number;
}

export interface RunSqlOptions {
  /** Overrides ZETARIS_API_KEY (the setup script passes the admin key). */
  apiKey?: string;
  limit?: number;
  timeoutMs?: number;
  retries?: number;
  config?: Config;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const RETRY_DELAYS_MS = [1_000, 3_000];
const MAX_DETAIL = 1_000;

function extractDetail(text: string, secrets: readonly string[]): string | undefined {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.startsWith("<")) return undefined; // empty or an HTML proxy page
  let detail = trimmed;
  try {
    const body = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ["msg", "message", "errorMessage", "error_message", "error", "detail", "details", "exception"]) {
      const v = body[key];
      if (typeof v === "string" && v.trim() !== "") {
        detail = v.trim();
        break;
      }
      if (v && typeof v === "object") {
        const nested = (v as Record<string, unknown>).message;
        detail = typeof nested === "string" ? nested : JSON.stringify(v);
        break;
      }
    }
  } catch {
    // Plain-text error body: use as is.
  }
  // Zetaris errors often embed a full Java stack trace; the useful part is before the first frame.
  detail = detail.split(/\r?\n\tat /)[0]!.trim();
  const safe = redact(detail, secrets);
  return safe.length > MAX_DETAIL ? `${safe.slice(0, MAX_DETAIL)}...` : safe;
}

function extractColumns(body: Record<string, unknown>): string[] | null {
  for (const key of ["columns", "columnNames", "header", "headers", "schema", "fields"]) {
    const v = body[key];
    if (!Array.isArray(v) || v.length === 0) continue;
    const names = v.map((c) => {
      if (typeof c === "string") return c;
      const o = c as Record<string, unknown> | null;
      const name = o?.name ?? o?.columnName ?? o?.label;
      return typeof name === "string" ? name : null;
    });
    if (names.every((n): n is string => n !== null)) return names;
  }
  return null;
}

// A 200 can still carry an error in some Zetaris responses.
function bodyError(body: Record<string, unknown>): boolean {
  if (Array.isArray(body.data)) return false;
  const status = typeof body.status === "string" ? body.status : "";
  return /^(error|failed|failure)$/i.test(status) || Boolean(body.error || body.errorMessage || body.exception);
}

async function attempt(
  url: string,
  statement: string,
  headers: Record<string, string>,
  requestId: string,
  limit: number,
  timeoutMs: number,
  doFetch: typeof fetch,
  secrets: readonly string[],
): Promise<Omit<SqlResult, "attempts">> {
  let status: number;
  let text: string;
  try {
    const response = await doFetch(url, {
      method: "POST",
      headers: { ...headers, "X-Request-ID": requestId },
      body: JSON.stringify({ queryId: randomUUID(), sql: statement, source: "SqlEditor", limit }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = response.status;
    text = await response.text();
  } catch (err) {
    const name = (err as Error | undefined)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new ZetarisError("timeout", `Zetaris did not answer within ${timeoutMs / 1000} s`, { requestId });
    }
    const code = (err as { cause?: { code?: unknown } } | undefined)?.cause?.code;
    throw new ZetarisError("unreachable", `Cannot reach Zetaris at ${url}${typeof code === "string" ? ` (${code})` : ""}`, {
      requestId,
      retryable: true,
    });
  }

  const detail = extractDetail(text, secrets);
  if (status === 401 || status === 403) {
    throw new ZetarisError("unauthorized", `Zetaris returned HTTP ${status} (unauthorized)`, { status, detail, requestId });
  }
  if (status < 200 || status >= 300) {
    // A 5xx that carries an SQL error message is deterministic ("already exists", syntax): don't retry it.
    const retryable = status >= 500 && ([502, 503, 504].includes(status) || detail === undefined);
    const kind = detail !== undefined ? "sql" : "http";
    throw new ZetarisError(kind, `Zetaris returned HTTP ${status}${detail ? `: ${detail}` : ""}`, {
      status,
      detail,
      requestId,
      retryable,
    });
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ZetarisError("invalid_response", "Zetaris returned a non-JSON response", { status, requestId });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ZetarisError("invalid_response", "Zetaris response is not a JSON object", { status, requestId });
  }
  const record = body as Record<string, unknown>;
  if (bodyError(record)) {
    throw new ZetarisError("sql", `Zetaris reported an error${detail ? `: ${detail}` : ""}`, { status, detail, requestId });
  }
  // DDL statements may answer without a data array; that is a success with no rows.
  const rows = Array.isArray(record.data) ? (record.data as unknown[]) : [];
  return { rows, columns: extractColumns(record), requestId };
}

/** Run ONE SQL statement on Zetaris. Retries network errors and bare 5xx only. */
export async function runSql(sql: string, options: RunSqlOptions = {}): Promise<SqlResult> {
  const config = options.config ?? getConfig();
  const apiKey = options.apiKey ?? config.zetaris.apiKey;
  if (!apiKey) throw new ZetarisError("config", "No Zetaris API key configured (ZETARIS_API_KEY)");
  if (!config.zetaris.orgId) throw new ZetarisError("config", "ZETARIS_ORG_ID is not set");

  const statement = normaliseStatement(sql);
  const url = `${config.zetaris.restUrl}/sql-editor/sqls/run`;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "X-Org-ID": config.zetaris.orgId,
    "Content-Type": "application/json",
  };
  const secrets = [...config.secrets, apiKey];
  const retries = Math.max(0, options.retries ?? RETRY_DELAYS_MS.length);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let n = 0; ; n++) {
    try {
      const result = await attempt(
        url,
        statement,
        headers,
        randomUUID(),
        options.limit ?? 1000,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        options.fetch ?? fetch,
        secrets,
      );
      return { ...result, attempts: n + 1 };
    } catch (err) {
      if (!(err instanceof ZetarisError) || !err.retryable || n >= retries) throw err;
      await sleep(RETRY_DELAYS_MS[Math.min(n, RETRY_DELAYS_MS.length - 1)]!);
    }
  }
}
