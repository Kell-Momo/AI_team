// The only module that reads process.env (see CLAUDE.md). Everything else receives a Config.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type LogLevel = "debug" | "info" | "warn" | "error";
export const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export interface Config {
  zetaris: {
    restUrl: string;
    orgId: string;
    apiKey: string;
    /** Only used by scripts/zetaris-setup.ts. */
    adminApiKey: string;
    /** Fully qualified USL namespace, e.g. lightning.metastore.growthloop.marketing */
    usl: string;
  };
  meterless: {
    baseUrl: string;
    runtimeToken: string;
    model: string;
  };
  sampleMode: boolean;
  port: number;
  logLevel: LogLevel;
  paths: {
    root: string;
    data: string;
    logs: string;
    memory: string;
    outbox: string;
  };
  /** Secret values to scrub from anything we log or return. */
  secrets: readonly string[];
}

type Env = Readonly<Record<string, string | undefined>>;

export class ConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    // Issues name the variable, never a secret value.
    super(`Invalid configuration: ${issues.join("; ")}`);
    this.name = "ConfigError";
  }
}

// Resolve from this file, not cwd, so scripts work from any directory.
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULTS = {
  ZETARIS_REST_URL: "http://localhost:8888/api/v1.0",
  ZETARIS_USL: "lightning.metastore.growthloop.marketing",
  METERLESS_BASE_URL: "http://127.0.0.1:8088/v1",
  METERLESS_MODEL: "meterless/auto",
  // 3000 is taken by the Zetaris UI.
  PORT: "8000",
  LOG_LEVEL: "info",
} as const;

/** Minimal .env parser: KEY=VALUE, `export` prefix, # comments, single/double quotes. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue; // Tolerate junk lines rather than refusing to start.
    const key = match[1]!;
    let value = match[2]!;
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out[key] = value;
  }
  return out;
}

/** Turn any pasted Nightshift URL (with or without /v1/...) into <origin>/v1. */
export function normaliseMeterlessBaseUrl(raw: string): string {
  const url = new URL(raw);
  return `${url.origin}/v1`;
}

/** Pure: builds a validated Config from an env map. */
export function loadConfig(env: Env, root: string = PROJECT_ROOT): Config {
  const issues: string[] = [];

  const get = (key: string, fallback = ""): string => {
    const value = env[key]?.trim();
    return value === undefined || value === "" ? fallback : value;
  };

  const httpUrl = (key: string, value: string): string => {
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
      return value.replace(/\/+$/, "");
    } catch {
      issues.push(`${key} must be an http(s) URL`);
      return value;
    }
  };

  // Header values: reject whitespace/control chars to prevent header injection.
  const headerSafe = (key: string, value: string): string => {
    if (!/^[\x21-\x7E]*$/.test(value)) issues.push(`${key} contains invalid characters`);
    return value;
  };

  const zetarisRestUrl = httpUrl("ZETARIS_REST_URL", get("ZETARIS_REST_URL", DEFAULTS.ZETARIS_REST_URL));

  // Interpolated into catalogue SQL as an identifier, so keep it strictly to dotted names.
  const usl = get("ZETARIS_USL", DEFAULTS.ZETARIS_USL);
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(usl)) {
    issues.push("ZETARIS_USL must be a dotted identifier like lightning.metastore.growthloop.marketing");
  }

  let meterlessBaseUrl = get("METERLESS_BASE_URL", DEFAULTS.METERLESS_BASE_URL);
  httpUrl("METERLESS_BASE_URL", meterlessBaseUrl);
  try {
    meterlessBaseUrl = normaliseMeterlessBaseUrl(meterlessBaseUrl);
  } catch {
    // Already reported by httpUrl.
  }

  const model = get("METERLESS_MODEL", DEFAULTS.METERLESS_MODEL);
  if (!/^[A-Za-z0-9._:/-]{1,100}$/.test(model)) issues.push("METERLESS_MODEL has invalid characters");

  let sampleMode = false;
  const rawSample = get("SAMPLE_MODE", "false").toLowerCase();
  if (["true", "1", "yes", "on"].includes(rawSample)) sampleMode = true;
  else if (!["false", "0", "no", "off"].includes(rawSample)) issues.push("SAMPLE_MODE must be true or false");

  const rawPort = get("PORT", DEFAULTS.PORT);
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) issues.push("PORT must be an integer 1-65535");

  const rawLevel = get("LOG_LEVEL", DEFAULTS.LOG_LEVEL).toLowerCase();
  if (!(LOG_LEVELS as readonly string[]).includes(rawLevel)) {
    issues.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}`);
  }

  // Secrets are optional here: adapters report a clear error (or fall back) when one is missing.
  const orgId = headerSafe("ZETARIS_ORG_ID", get("ZETARIS_ORG_ID"));
  const apiKey = headerSafe("ZETARIS_API_KEY", get("ZETARIS_API_KEY"));
  const adminApiKey = headerSafe("ZETARIS_ADMIN_API_KEY", get("ZETARIS_ADMIN_API_KEY"));
  const runtimeToken = headerSafe("METERLESS_RUNTIME_TOKEN", get("METERLESS_RUNTIME_TOKEN"));

  if (issues.length > 0) throw new ConfigError(issues);

  return {
    zetaris: { restUrl: zetarisRestUrl, orgId, apiKey, adminApiKey, usl },
    meterless: { baseUrl: meterlessBaseUrl, runtimeToken, model },
    sampleMode,
    port,
    logLevel: rawLevel as LogLevel,
    paths: {
      root,
      data: join(root, "data"),
      logs: join(root, "logs"),
      memory: join(root, ".memory"),
      outbox: join(root, "outbox"),
    },
    secrets: [apiKey, adminApiKey, runtimeToken].filter((s) => s !== ""),
  };
}

let cached: Config | undefined;

/** Loads .env (if present) + process.env once. Real environment variables win over .env. */
export function getConfig(): Config {
  if (cached) return cached;
  const envFile = join(PROJECT_ROOT, ".env");
  const fileEnv = existsSync(envFile) ? parseDotEnv(readFileSync(envFile, "utf8")) : {};
  cached = loadConfig({ ...fileEnv, ...process.env });
  return cached;
}

export const REDACTED = "...redacted";

// Keys whose values are secrets regardless of content.
const SENSITIVE_KEY = /(token|api[_-]?key|secret|password|authorization)/i;
// Short strings would cause false positives all over the logs.
const MIN_SECRET_LENGTH = 4;

/** Scrub known secret values, Bearer tokens and sensitive keys. Returns a redacted copy. */
export function redact(value: string, secrets?: readonly string[]): string;
export function redact(value: unknown, secrets?: readonly string[]): unknown;
export function redact(value: unknown, secrets: readonly string[] = []): unknown {
  // Longest first so a secret containing another secret is fully replaced.
  const known = secrets.filter((s) => s.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
  const seen = new WeakSet<object>();

  const text = (s: string): string => {
    let out = s;
    for (const secret of known) out = out.split(secret).join(REDACTED);
    return out.replace(/\bBearer\s+(?!\.\.\.redacted)[^\s"',;]+/gi, `Bearer ${REDACTED}`);
  };

  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return text(v);
    if (v instanceof Error) return text(`${v.name}: ${v.message}`);
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(v)) {
      out[k] = SENSITIVE_KEY.test(k) && child !== "" && child != null ? REDACTED : walk(child);
    }
    return out;
  };

  return walk(value);
}
