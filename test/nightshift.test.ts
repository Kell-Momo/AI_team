import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { chat, listModels, NightshiftError } from "../src/adapters/nightshift.ts";
import { createLlm } from "../src/adapters/llm.ts";
import { createTracer, type Tracer } from "../src/trace.ts";

const TOKEN = "ns-test-token-abc123";
const config = loadConfig({ METERLESS_BASE_URL: "http://127.0.0.1:8088/v1/chat/completions", METERLESS_RUNTIME_TOKEN: TOKEN });
const noSleep = async () => {};
const isKind = (kind: string) => (err: unknown) => err instanceof NightshiftError && err.kind === kind;

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: (Response | Error)[], calls: Call[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more fake responses");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const completion = (content: string, extra: Record<string, unknown> = {}) =>
  json({ model: "meterless/auto", choices: [{ message: { role: "assistant", content } }], ...extra });

test("chat sends the provider contract and returns the routed model", async () => {
  const calls: Call[] = [];
  const result = await chat([{ role: "user", content: "hi" }], {
    config,
    fetch: fakeFetch([completion("hello", { meterless: { routed_model: "nvidia/llama-3.3-70b" } })], calls),
  });
  assert.equal(result.text, "hello");
  assert.equal(result.model, "nvidia/llama-3.3-70b");
  assert.equal(result.requestedModel, "meterless/auto");

  const [call] = calls;
  assert.equal(call?.url, "http://127.0.0.1:8088/v1/chat/completions"); // pasted URL normalised
  const headers = call?.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(headers["meterless-app"], "growthloop");
  assert.equal(headers["meterless-scope"], "user");
  const body = JSON.parse(String(call?.init.body)) as Record<string, unknown>;
  assert.deepEqual((body.messages as unknown[])[0], { role: "system", content: "/no_think" });
  assert.equal(body.max_tokens, 2000);
  assert.equal(body.stream, false);
  assert.equal(body.model, "meterless/auto");
});

test("chat falls back to response.model when no routed model is given", async () => {
  const result = await chat([{ role: "user", content: "hi" }], {
    config,
    fetch: fakeFetch([json({ model: "qwen3-32b", choices: [{ message: { content: "ok" } }] })]),
  });
  assert.equal(result.model, "qwen3-32b");
});

test("chat retries 429, 502 and timeouts with 2/4/8 s backoff", async () => {
  const waits: number[] = [];
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  const result = await chat([{ role: "user", content: "hi" }], {
    config,
    sleep: async (ms) => void waits.push(ms),
    fetch: fakeFetch([json({}, 429), json({}, 502), timeout, completion("finally")]),
  });
  assert.equal(result.text, "finally");
  assert.equal(result.attempts, 4);
  assert.deepEqual(waits, [2000, 4000, 8000]);
});

test("chat gives up after 3 retries and does not retry 500", async () => {
  await assert.rejects(
    chat([{ role: "user", content: "hi" }], { config, sleep: noSleep, fetch: fakeFetch([json({}, 429), json({}, 429), json({}, 429), json({}, 429)]) }),
    isKind("rate_limited"),
  );
  const calls: Call[] = [];
  await assert.rejects(
    chat([{ role: "user", content: "hi" }], { config, sleep: noSleep, fetch: fakeFetch([json({ error: { message: "boom" } }, 500)], calls) }),
    isKind("http"),
  );
  assert.equal(calls.length, 1);
});

test("errors never contain the token", async () => {
  await assert.rejects(
    chat([{ role: "user", content: "hi" }], { config, fetch: fakeFetch([json({ error: { message: `bad token ${TOKEN}` } }, 400)]) }),
    (err: unknown) => {
      assert.ok(err instanceof NightshiftError);
      assert.doesNotMatch(`${err.message} ${err.detail} ${JSON.stringify(err)}`, new RegExp(TOKEN));
      return true;
    },
  );
});

test("listModels: ids on success, 401/403 is unauthorized, network error is unreachable", async () => {
  assert.deepEqual(await listModels({ config, fetch: fakeFetch([json({ data: [{ id: "meterless/auto" }, { id: "x" }] })]) }), ["meterless/auto", "x"]);
  await assert.rejects(listModels({ config, fetch: fakeFetch([json({}, 401)]) }), isKind("unauthorized"));
  await assert.rejects(listModels({ config, fetch: fakeFetch([json({}, 403)]) }), isKind("unauthorized"));
  const refused = new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
  await assert.rejects(listModels({ config, fetch: fakeFetch([refused]) }), isKind("unreachable"));
});

test("chat rejects a reply without content and refuses to run without a token", async () => {
  await assert.rejects(chat([{ role: "user", content: "hi" }], { config, fetch: fakeFetch([json({ choices: [] })]) }), isKind("invalid_response"));
  await assert.rejects(chat([{ role: "user", content: "hi" }], { config: loadConfig({}) }), isKind("config"));
});

// ---------- Llm port ----------

function withTracer(fn: (tracer: Tracer) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "growthloop-llm-"));
    try {
      await fn(createTracer({ logsDir: dir, stdout: () => {} }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const req = { agent: "DataAnalyst", system: "sys", user: "question" };

test(
  "Llm returns the text and routed model, and traces it",
  withTracer(async (tracer) => {
    const llm = createLlm({
      tracer,
      config,
      chat: async () => ({ text: "{}", model: "nvidia/llama-3.3-70b", requestedModel: "meterless/auto", attempts: 2, ms: 5 }),
    });
    assert.deepEqual(await llm(req), { text: "{}", model: "nvidia/llama-3.3-70b" });
    assert.deepEqual(llm.models(), ["nvidia/llama-3.3-70b"]);
    const [event] = tracer.events();
    assert.equal(event?.status, "success");
    assert.equal(event?.model, "nvidia/llama-3.3-70b");
    assert.equal(event?.agent_name, "DataAnalyst");
    assert.equal(event?.retry_count, 1);
  }),
);

test(
  "Llm returns null in SAMPLE_MODE without calling Nightshift",
  withTracer(async (tracer) => {
    let called = false;
    const llm = createLlm({
      tracer,
      config: loadConfig({ SAMPLE_MODE: "true" }),
      chat: async () => {
        called = true;
        throw new Error("must not be called");
      },
    });
    assert.equal(await llm(req), null);
    assert.equal(called, false);
    assert.equal(tracer.events()[0]?.status, "fallback");
    assert.match(tracer.events()[0]!.output_summary, /SAMPLE_MODE/);
  }),
);

test(
  "Llm opens the circuit after unreachable/unauthorized and stops calling",
  withTracer(async (tracer) => {
    for (const kind of ["unreachable", "unauthorized"] as const) {
      let calls = 0;
      const llm = createLlm({
        tracer,
        config,
        chat: async () => {
          calls++;
          throw new NightshiftError(kind, `Nightshift ${kind}`);
        },
      });
      assert.equal(await llm(req), null);
      assert.equal(await llm({ ...req, agent: "Strategist" }), null);
      assert.equal(calls, 1, `${kind}: second call must not reach Nightshift`);
    }
    assert.ok(tracer.events().every((e) => e.status === "fallback"));
  }),
);

test(
  "Llm keeps trying after a per-request failure",
  withTracer(async (tracer) => {
    let calls = 0;
    const llm = createLlm({
      tracer,
      config,
      chat: async () => {
        calls++;
        if (calls === 1) throw new NightshiftError("rate_limited", "429");
        return { text: "ok", model: "m", requestedModel: "meterless/auto", attempts: 1, ms: 1 };
      },
    });
    assert.equal(await llm(req), null);
    assert.deepEqual(await llm(req), { text: "ok", model: "m" });
    assert.deepEqual(tracer.events().map((e) => e.status), ["fallback", "success"]);
  }),
);
