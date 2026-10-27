// One-off, idempotent Zetaris setup: CSV file tables -> USL tables -> data-quality rule.
// Safe to re-run: "already exists" counts as success. Needs REST access only (no Docker);
// copy the CSVs into the container first with scripts/zetaris/load-data.sh.
import { ConfigError, getConfig } from "../src/config.ts";
import { runSql, toObjects, ZetarisError } from "../src/adapters/zetaris.ts";
import { loadSampleData } from "../src/analytics/sample.ts";

const FILE_DB = "growthloop_files";
const FILE_DIR = "/home/zetaris/customer-data/shared/growthloop";
const FILE_TABLES = ["posts", "post_metrics", "ad_spend", "sales"] as const;

type Outcome = "OK" | "ALREADY EXISTS" | "FAILED" | "SKIPPED";

interface Step {
  sql: string;
  /** For COUNT(*) checks: the row count the local CSVs say we should see. */
  expect?: number;
  /** Print the first rows of the result (e.g. RUN DQ output). */
  show?: boolean;
}

interface Phase {
  name: string;
  steps: Step[];
}

// Re-running DDL makes Zetaris complain that things exist; that is the idempotent success path.
const ALREADY = /already\s+(exists?|activ|regist|defin|deploy|creat)/i;

function buildPhases(usl: string, expected: Record<string, number>): Phase[] {
  const dot = usl.lastIndexOf(".");
  const namespace = usl.slice(0, dot);
  const uslName = usl.slice(dot + 1);
  const f = (t: string) => `${FILE_DB}.${t}`;
  const u = (t: string) => `${usl}.${t}`;
  const count = (table: string, key: string): Step => ({ sql: `SELECT COUNT(*) AS n FROM ${table}`, expect: expected[key] });
  // A fresh instance has no lightning.metastore yet ("parent namespace : metastore is not existing"),
  // so create every ancestor below the catalog, outermost first.
  const segments = namespace.split(".");
  const namespaces = segments.slice(2).map((_, i) => segments.slice(0, i + 2).join(".")).concat(namespace);

  return [
    {
      name: "Lightning file tables",
      steps: [
        { sql: `CREATE LIGHTNING DATABASE ${FILE_DB} DESCRIBE BY "GrowthLoop synthetic CSVs"` },
        ...FILE_TABLES.map((t) => ({
          sql: `CREATE LIGHTNING FILESTORE TABLE ${t} FROM ${FILE_DB} FORMAT CSV OPTIONS (PATH "${FILE_DIR}/${t}.csv", header "true", inferSchema "true")`,
        })),
      ],
    },
    {
      name: "File table row counts",
      steps: FILE_TABLES.map((t) => count(f(t), t)),
    },
    {
      name: "USL namespace and schema",
      steps: [
        ...namespaces.map((ns) => ({ sql: `CREATE NAMESPACE IF NOT EXISTS ${ns}` })),
        {
          // One request; each CREATE TABLE must start on its own line.
          sql: [
            `COMPILE USL IF NOT EXISTS ${uslName} DEPLOY NAMESPACE ${namespace} DDL`,
            "CREATE TABLE post_performance(post_id varchar(20) NOT NULL PRIMARY KEY, posted_date varchar(10), platform varchar(20), format varchar(20), pillar varchar(30), language varchar(10), post_hour int, has_price varchar(5), has_cta varchar(5), origin varchar(10), promo_code varchar(20), caption varchar(400), reach int, engagements int, link_clicks int)",
            "CREATE TABLE campaign_daily(row_id varchar(60) NOT NULL PRIMARY KEY, ad_date varchar(10), campaign_id varchar(30), platform varchar(20), spend_xaf double, impressions int, clicks int, promo_code varchar(20))",
            "CREATE TABLE orders(order_id varchar(20) NOT NULL PRIMARY KEY, order_date varchar(10), channel varchar(20), promo_code varchar(20), amount_xaf double)",
          ].join("\n"),
        },
      ],
    },
    {
      name: "Activate USL tables",
      // Explicit CASTs to the DDL types: inferSchema guesses (timestamp vs string, int vs double) vary.
      steps: [
        {
          sql: [
            `ACTIVATE USL TABLE ${u("post_performance")} AS SELECT`,
            "  COALESCE(CAST(p.post_id AS STRING), '') AS post_id,",
            "  substr(CAST(p.posted_at AS STRING), 1, 10) AS posted_date,",
            "  CAST(p.platform AS STRING) AS platform,",
            "  CAST(p.format AS STRING) AS format,",
            "  CAST(p.pillar AS STRING) AS pillar,",
            "  CAST(p.language AS STRING) AS language,",
            "  CAST(p.post_hour AS INT) AS post_hour,",
            "  CAST(p.has_price AS STRING) AS has_price,",
            "  CAST(p.has_cta AS STRING) AS has_cta,",
            "  CAST(p.origin AS STRING) AS origin,",
            "  CAST(p.promo_code AS STRING) AS promo_code,",
            "  CAST(p.caption AS STRING) AS caption,",
            "  CAST(m.reach AS INT) AS reach,",
            "  CAST(m.likes + m.comments + m.shares + m.saves AS INT) AS engagements,",
            "  CAST(m.link_clicks AS INT) AS link_clicks",
            `FROM ${f("posts")} p JOIN ${f("post_metrics")} m ON p.post_id = m.post_id`,
          ].join("\n"),
        },
        {
          sql: [
            `ACTIVATE USL TABLE ${u("campaign_daily")} AS SELECT`,
            "  COALESCE(concat(CAST(a.campaign_id AS STRING), '-', substr(CAST(a.ad_date AS STRING), 1, 10)), '') AS row_id,",
            "  substr(CAST(a.ad_date AS STRING), 1, 10) AS ad_date,",
            "  CAST(a.campaign_id AS STRING) AS campaign_id,",
            "  CAST(a.platform AS STRING) AS platform,",
            "  CAST(a.spend_xaf AS DOUBLE) AS spend_xaf,",
            "  CAST(a.impressions AS INT) AS impressions,",
            "  CAST(a.clicks AS INT) AS clicks,",
            "  CAST(a.promo_code AS STRING) AS promo_code",
            `FROM ${f("ad_spend")} a`,
          ].join("\n"),
        },
        {
          sql: [
            `ACTIVATE USL TABLE ${u("orders")} AS SELECT`,
            "  COALESCE(CAST(s.order_id AS STRING), '') AS order_id,",
            "  substr(CAST(s.order_date AS STRING), 1, 10) AS order_date,",
            "  CAST(s.channel AS STRING) AS channel,",
            "  CAST(s.promo_code AS STRING) AS promo_code,",
            "  CAST(s.amount_xaf AS DOUBLE) AS amount_xaf",
            `FROM ${f("sales")} s`,
          ].join("\n"),
        },
      ],
    },
    {
      name: "USL row counts",
      steps: [
        count(u("post_performance"), "post_performance"),
        count(u("campaign_daily"), "campaign_daily"),
        count(u("orders"), "orders"),
      ],
    },
    {
      name: "Data quality",
      steps: [
        { sql: `REGISTER DQ valid_metrics TABLE ${u("post_performance")} AS reach > 0 AND engagements <= reach` },
        { sql: `RUN DQ valid_metrics TABLE ${u("post_performance")}`, show: true },
        // All rules on the table, including the primary-key rule Zetaris derives from the DDL.
        { sql: `RUN DQ TABLE ${u("post_performance")}`, show: true },
        {
          // Independent check of what the DQ rule should flag.
          sql: `SELECT COUNT(*) AS n FROM ${u("post_performance")} WHERE NOT (reach > 0 AND engagements <= reach)`,
          expect: expected.invalid,
        },
      ],
    },
  ];
}

const firstLine = (sql: string) => {
  const line = sql.split("\n")[0]!;
  return line.length > 110 ? `${line.slice(0, 107)}...` : line;
};

function print(outcome: Outcome, sql: string, note = ""): void {
  console.log(`  ${outcome.padEnd(14)} ${firstLine(sql)}${note ? `  ${note}` : ""}`);
}

async function runStep(step: Step, apiKey: string): Promise<Outcome> {
  try {
    const result = await runSql(step.sql, { apiKey });
    if (step.expect !== undefined) {
      const [row] = toObjects(result.rows.slice(0, 1), ["n"]);
      const n = row?.n;
      if (n !== step.expect) {
        print("FAILED", step.sql, `-> ${String(n)} (expected ${step.expect})`);
        return "FAILED";
      }
      print("OK", step.sql, `-> ${n}`);
      return "OK";
    }
    print("OK", step.sql);
    if (step.show) {
      for (const row of result.rows.slice(0, 5)) console.log(`                 ${JSON.stringify(row)}`);
      if (result.rows.length > 5) console.log(`                 ... ${result.rows.length - 5} more rows`);
    }
    return "OK";
  } catch (err) {
    if (!(err instanceof ZetarisError)) throw err;
    // These mean nothing else can work either: stop instead of printing 20 identical failures.
    if (err.kind === "unreachable" || err.kind === "unauthorized" || err.kind === "config") throw err;
    const text = err.detail ?? err.message;
    if (ALREADY.test(text)) {
      print("ALREADY EXISTS", step.sql);
      return "ALREADY EXISTS";
    }
    print("FAILED", step.sql);
    console.log(`                 Zetaris: ${text}`);
    return "FAILED";
  }
}

async function main(): Promise<number> {
  const config = getConfig();
  const keyName = config.zetaris.adminApiKey ? "ZETARIS_ADMIN_API_KEY" : "ZETARIS_API_KEY";
  const apiKey = config.zetaris.adminApiKey || config.zetaris.apiKey;

  // Expected counts come from the local CSVs (the same files load-data.sh copied), never hard-coded.
  const data = loadSampleData(config.paths.data);
  const expected: Record<string, number> = {
    posts: data.post_performance.length,
    post_metrics: data.post_performance.length,
    ad_spend: data.campaign_daily.length,
    sales: data.orders.length,
    post_performance: data.post_performance.length,
    campaign_daily: data.campaign_daily.length,
    orders: data.orders.length,
    invalid: data.post_performance.filter((r) => !(r.reach > 0 && r.engagements <= r.reach)).length,
  };

  console.log(`Zetaris setup -> ${config.zetaris.restUrl} (key: ${keyName}, USL: ${config.zetaris.usl})`);

  let failed = 0;
  let blockedBy: string | null = null;
  for (const phase of buildPhases(config.zetaris.usl, expected)) {
    console.log(`\n== ${phase.name}`);
    let phaseFailed = false;
    for (const step of phase.steps) {
      if (blockedBy) {
        print("SKIPPED", step.sql, `(after failures in "${blockedBy}")`);
        failed++;
        continue;
      }
      if ((await runStep(step, apiKey)) === "FAILED") {
        phaseFailed = true;
        failed++;
      }
    }
    // Later phases build on this one; running them would only add noise.
    if (phaseFailed && !blockedBy) blockedBy = phase.name;
  }

  console.log(failed === 0 ? "\nSetup complete." : `\nSetup finished with ${failed} failed or skipped statement(s).`);
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof ZetarisError || err instanceof ConfigError) {
      console.error(`\n${err.message}`);
      if (err instanceof ZetarisError && err.hint) console.error(err.hint);
    } else {
      console.error(`\n${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  },
);
