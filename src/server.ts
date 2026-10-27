// HTTP server (node:http): JSON API (GET /health, POST /run) plus the built UI from frontend/dist.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { getConfig, PROJECT_ROOT, redact, type Config } from "./config.ts";
import { run as runOrchestrator, RunBusyError, RunFailedError, ValidationError } from "./orchestrator.ts";

export const MAX_BODY_BYTES = 32 * 1024;
// Runs take minutes (model calls with retries); the default 5-minute request timeout is too tight.
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
  }
}

const BASE_HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...BASE_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

const sendError = (res: ServerResponse, e: HttpError) =>
  sendJson(res, e.status, { error: { code: e.code, message: e.message, ...(e.details.length ? { details: e.details } : {}) } });

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_BODY_BYTES) {
      reject(new HttpError(413, "payload_too_large", `Request body over ${MAX_BODY_BYTES / 1024} KB`));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "payload_too_large", `Request body over ${MAX_BODY_BYTES / 1024} KB`));
        req.removeAllListeners("data");
        req.resume(); // drain without buffering
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export interface ServerOptions {
  config?: Config;
  /** Injectable for tests. */
  run?: typeof runOrchestrator;
  distDir?: string;
}

export function createAppServer(options: ServerOptions = {}): Server {
  const config = options.config ?? getConfig();
  const runFn = options.run ?? runOrchestrator;
  const distDir = resolve(options.distDir ?? join(PROJECT_ROOT, "frontend", "dist"));

  async function handleRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json") throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
    const text = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new HttpError(400, "invalid_json", "Request body is not valid JSON");
    }
    try {
      sendJson(res, 200, await runFn(body, { config }));
    } catch (err) {
      if (err instanceof ValidationError) throw new HttpError(400, err.code, "Invalid input", err.details);
      if (err instanceof RunBusyError) throw new HttpError(409, err.code, err.message);
      if (err instanceof RunFailedError) {
        console.error(`[server] ${err.message}: ${redact(String((err.cause as Error)?.message ?? err.cause), config.secrets)}`);
        throw new HttpError(500, err.code, err.message);
      }
      throw err;
    }
  }

  function serveStatic(pathname: string, res: ServerResponse, headOnly: boolean): void {
    if (!existsSync(join(distDir, "index.html"))) {
      throw new HttpError(404, "ui_not_built", "The web UI is not built. Run: cd frontend && npm install && npm run build");
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, "bad_path", "Malformed URL path");
    }
    if (decoded.includes("\0")) throw new HttpError(400, "bad_path", "Malformed URL path");
    // Resolve inside distDir and refuse anything that escapes it (../, absolute paths, drive letters).
    const target = resolve(distDir, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
    if (target !== distDir && !target.startsWith(distDir + sep)) throw new HttpError(404, "not_found", "Not found");

    let file = target;
    if (!existsSync(file) || statSync(file).isDirectory()) {
      // SPA fallback for app routes; a missing asset (has an extension) is a real 404.
      if (extname(decoded) !== "") throw new HttpError(404, "not_found", "Not found");
      file = join(distDir, "index.html");
    }
    const data = readFileSync(file);
    const isIndex = file.endsWith(`${sep}index.html`);
    res.writeHead(200, {
      ...BASE_HEADERS,
      "Content-Type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": data.length,
      // Vite fingerprints assets, so they can be cached; index.html must always be fresh.
      "Cache-Control": isIndex ? "no-cache" : "public, max-age=31536000, immutable",
    });
    res.end(headOnly ? undefined : data);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      if (url.pathname === "/health") {
        if (method !== "GET") throw new HttpError(405, "method_not_allowed", "Use GET /health");
        sendJson(res, 200, { status: "ok", sample_mode: config.sampleMode, source: config.sampleMode ? "sample" : "zetaris" });
      } else if (url.pathname === "/run") {
        if (method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST /run");
        await handleRun(req, res);
      } else if (method === "GET" || method === "HEAD") {
        serveStatic(url.pathname, res, method === "HEAD");
      } else {
        throw new HttpError(405, "method_not_allowed", `${method} not allowed`);
      }
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) {
        if (err.status === 413) res.setHeader("Connection", "close");
        sendError(res, err);
        return;
      }
      // Never a stack trace to the client; a redacted one-line message to the server log.
      console.error(`[server] internal error: ${redact(err instanceof Error ? err.message : String(err), config.secrets)}`);
      sendError(res, new HttpError(500, "internal_error", "Internal server error"));
    }
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return server;
}

export function startServer(config: Config = getConfig()): Server {
  const server = createAppServer({ config });
  server.listen(config.port, "0.0.0.0", () => {
    console.log(`GrowthLoop listening on http://0.0.0.0:${config.port} (${config.sampleMode ? "SAMPLE_MODE: local CSVs" : `Zetaris ${config.zetaris.restUrl}`})`);
  });
  return server;
}
