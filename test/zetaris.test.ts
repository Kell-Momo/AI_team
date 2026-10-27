import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { normaliseStatement, runSql, toObjects, ZetarisError } from "../src/adapters/zetaris.ts";

const isKind = (kind: string) => (err: unknown) => err instanceof ZetarisError && err.kind === kind;

test("normaliseStatement trims and drops trailing semicolons", () => {
  assert.equal(normaliseStatement("  SELECT 1 ;  "), "SELECT 1");
  assert.equal(normaliseStatement("SELECT 1;;\n-- done\n"), "SELECT 1");
});

test("normaliseStatement keeps newlines (COMPILE USL needs them)", () => {
  const ddl = "COMPILE USL m DEPLOY NAMESPACE a.b DDL\nCREATE TABLE t(x int)\nCREATE TABLE u(y int)";
  assert.equal(normaliseStatement(ddl), ddl);
});

test("normaliseStatement ignores semicolons inside quotes and comments", () => {
  for (const sql of [
    "SELECT ';' AS s",
    'CREATE LIGHTNING DATABASE d DESCRIBE BY "a; b"',
    "SELECT `we;ird` FROM t",
    "SELECT 'it''s; fine'",
    "SELECT 1 -- a; b\nFROM t",
    "SELECT /* x; y */ 1",
  ]) {
    assert.equal(normaliseStatement(sql), sql);
  }
});

test("normaliseStatement rejects multiple, empty and unterminated statements", () => {
  assert.throws(() => normaliseStatement("SELECT 1; DROP TABLE t"), isKind("invalid_statement"));
  assert.throws(() => normaliseStatement("  ;  "), isKind("invalid_statement"));
  assert.throws(() => normaliseStatement(""), isKind("invalid_statement"));
  assert.throws(() => normaliseStatement("SELECT 'open"), isKind("invalid_statement"));
});

test("toObjects maps array rows by column order and coerces numeric strings", () => {
  const rows = [["P001", "1821", "0.5", "-3", "2026-07-01", "007", null]];
  assert.deepEqual(toObjects(rows, ["post_id", "reach", "rate", "delta", "day", "code", "promo"]), [
    { post_id: "P001", reach: 1821, rate: 0.5, delta: -3, day: "2026-07-01", code: "007", promo: null },
  ]);
});

test("toObjects maps object rows, case-insensitively", () => {
  const rows = [{ POST_ID: "P002", Reach: "4523" }];
  assert.deepEqual(toObjects(rows, ["post_id", "reach"]), [{ post_id: "P002", reach: 4523 }]);
});

test("toObjects keepAsString, unsafe integers and native numbers", () => {
  const [row] = toObjects([["2026", "9007199254740993", 12, true]], ["promo_code", "big", "n", "flag"], {
    keepAsString: ["promo_code"],
  });
  assert.deepEqual(row, { promo_code: "2026", big: "9007199254740993", n: 12, flag: true });
});

test("toObjects rejects width mismatches and missing columns", () => {
  assert.throws(() => toObjects([["a"]], ["x", "y"]), isKind("invalid_response"));
  assert.throws(() => toObjects([{ x: 1 }], ["x", "y"]), isKind("invalid_response"));
  assert.throws(() => toObjects(["oops"], ["x"]), isKind("invalid_response"));
});

// runSql with an injected fetch: no network involved.
const config = loadConfig({ ZETARIS_ORG_ID: "org-1", ZETARIS_API_KEY: "zk-test-secret-123" });
const noSleep = async () => {};

test("runSql sends the documented request and returns rows", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(JSON.stringify({ data: [["95"]] }), { status: 200 });
  }) as unknown as typeof fetch;

  const result = await runSql("SELECT COUNT(*) FROM t;", { config, fetch: fakeFetch });
  assert.deepEqual(result.rows, [["95"]]);
  assert.equal(seen?.url, "http://localhost:8888/api/v1.0/sql-editor/sqls/run");
  const headers = seen?.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer zk-test-secret-123");
  assert.equal(headers["X-Org-ID"], "org-1");
  assert.match(headers["X-Request-ID"]!, /^[0-9a-f-]{36}$/);
  const body = JSON.parse(String(seen?.init.body)) as Record<string, unknown>;
  assert.equal(body.sql, "SELECT COUNT(*) FROM t");
  assert.equal(body.source, "SqlEditor");
  assert.equal(body.limit, 1000);
  assert.match(String(body.queryId), /^[0-9a-f-]{36}$/);
});

test("runSql retries a bare 503, then succeeds", async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls++;
    return calls === 1 ? new Response("", { status: 503 }) : new Response('{"data":[]}', { status: 200 });
  }) as unknown as typeof fetch;
  const result = await runSql("SELECT 1", { config, fetch: fakeFetch, sleep: noSleep });
  assert.equal(result.attempts, 2);
});

test("runSql does not retry a 500 that carries an SQL error, and redacts the key", async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ message: "Table already exists (key zk-test-secret-123)" }), { status: 500 });
  }) as unknown as typeof fetch;
  await assert.rejects(runSql("CREATE TABLE t(x int)", { config, fetch: fakeFetch, sleep: noSleep }), (err: unknown) => {
    assert.ok(err instanceof ZetarisError);
    assert.equal(err.kind, "sql");
    assert.match(err.detail ?? "", /already exists/);
    assert.doesNotMatch(`${err.message} ${err.detail}`, /zk-test-secret-123/);
    return true;
  });
  assert.equal(calls, 1);
});

test("runSql keeps only the first part of a Java stack trace in msg", async () => {
  const msg = "org.apache.spark.sql.AnalysisException: parent namespace : metastore is not existing\n\tat com.zetaris.Foo.bar(Foo.scala:42)\n\tat java.base/Thread.run";
  const fakeFetch = (async () => new Response(JSON.stringify({ msg }), { status: 500 })) as unknown as typeof fetch;
  await assert.rejects(runSql("CREATE NAMESPACE x", { config, fetch: fakeFetch, sleep: noSleep }), (err: unknown) => {
    assert.ok(err instanceof ZetarisError);
    assert.equal(err.detail, "org.apache.spark.sql.AnalysisException: parent namespace : metastore is not existing");
    return true;
  });
});

test("runSql maps 401 to unauthorized and network errors to unreachable", async () => {
  const unauthorized = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(runSql("SELECT 1", { config, fetch: unauthorized }), isKind("unauthorized"));

  let calls = 0;
  const down = (async () => {
    calls++;
    throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
  }) as unknown as typeof fetch;
  await assert.rejects(runSql("SELECT 1", { config, fetch: down, sleep: noSleep }), (err: unknown) => {
    assert.ok(err instanceof ZetarisError && err.kind === "unreachable");
    assert.match(err.message, /ECONNREFUSED/);
    return true;
  });
  assert.equal(calls, 3); // 1 try + 2 retries
});

test("runSql refuses to run without a key", async () => {
  await assert.rejects(runSql("SELECT 1", { config: loadConfig({}) }), isKind("config"));
});
