// Fixed query catalogue. The LLM never writes SQL: agents pick queries from here by id.
// Every query has two equivalent implementations returning identical columns:
// sql() for the Zetaris USL tables, compute() over the SAMPLE_MODE in-memory tables.
import type { Cell } from "../adapters/zetaris.ts";
import type { PostPerformanceRow, SampleData } from "./sample.ts";

export interface Period {
  start: string;
  end: string;
}

export type Row = Record<string, Cell>;

export const QUERY_IDS = [
  "format_performance",
  "pillar_performance",
  "language_performance",
  "timing_performance",
  "platform_performance",
  "cta_performance",
  "origin_comparison",
  "promo_roi",
  "top_posts",
  "data_quality",
] as const;
export type QueryId = (typeof QUERY_IDS)[number];

export interface QuerySpec {
  id: QueryId;
  title: string;
  columns: readonly string[];
  /** Column that identifies a row (what Evidence.segment refers to); null = single-row result. */
  keyColumn: string | null;
  /** Text columns that must never be coerced to numbers. */
  textColumns: readonly string[];
  primaryMetric: string;
  /** Segment queries compare groups of posts and share the same columns. */
  segmentQuery: boolean;
  sql(period: Period, usl: string): string;
  compute(data: SampleData, period: Period): Row[];
}

export class QueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryError";
  }
}

// Values interpolated into SQL are validated first; nothing else from outside reaches a statement.
export function assertPeriod(period: Period): void {
  const valid = (d: unknown) =>
    typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) &&
    new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);
  if (!valid(period?.start) || !valid(period?.end)) throw new QueryError("Period dates must be valid YYYY-MM-DD");
  if (period.start > period.end) throw new QueryError("Period start must be on or before end");
}

export function assertUsl(usl: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(usl)) {
    throw new QueryError("USL must be a dotted identifier");
  }
}

/** Half-up rounding like Spark's ROUND, without binary float artefacts (1.005 -> 1.01). */
export function round(x: number, decimals: number): number {
  return Number(`${Math.round(Number(`${x}e${decimals}`))}e-${decimals}`);
}

const VALID_SQL = "reach > 0 AND engagements <= reach";
const isValid = (r: PostPerformanceRow) => r.reach > 0 && r.engagements <= r.reach;
const inPeriod = (date: string, p: Period) => date >= p.start && date <= p.end;
const dateFilter = (col: string, p: Period) => `${col} >= '${p.start}' AND ${col} <= '${p.end}'`;
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const engagementRate = (r: PostPerformanceRow) => r.engagements / r.reach;

const SEGMENT_COLUMNS = ["segment", "posts", "avg_engagement_rate", "avg_reach", "avg_clicks"] as const;

function segmentQuery(
  id: QueryId,
  title: string,
  segmentSql: string,
  segmentOf: (r: PostPerformanceRow) => string,
): QuerySpec {
  return {
    id,
    title,
    columns: SEGMENT_COLUMNS,
    keyColumn: "segment",
    textColumns: ["segment"],
    primaryMetric: "avg_engagement_rate",
    segmentQuery: true,
    sql(period, usl) {
      assertPeriod(period);
      assertUsl(usl);
      return [
        "SELECT segment, COUNT(*) AS posts,",
        "  ROUND(AVG(CAST(engagements AS DOUBLE) / reach), 4) AS avg_engagement_rate,",
        "  ROUND(AVG(reach), 1) AS avg_reach,",
        "  ROUND(AVG(link_clicks), 1) AS avg_clicks",
        `FROM (SELECT ${segmentSql} AS segment, reach, engagements, link_clicks`,
        `  FROM ${usl}.post_performance`,
        `  WHERE ${dateFilter("posted_date", period)} AND ${VALID_SQL}) t`,
        "GROUP BY segment",
        "ORDER BY avg_engagement_rate DESC, segment",
      ].join("\n");
    },
    compute(data, period) {
      assertPeriod(period);
      const groups = new Map<string, PostPerformanceRow[]>();
      for (const r of data.post_performance) {
        if (!inPeriod(r.posted_date, period) || !isValid(r)) continue;
        const key = segmentOf(r);
        groups.set(key, [...(groups.get(key) ?? []), r]);
      }
      return [...groups.entries()]
        .map(([segment, rows]) => ({
          segment,
          posts: rows.length,
          avg_engagement_rate: round(avg(rows.map(engagementRate)), 4),
          avg_reach: round(avg(rows.map((r) => r.reach)), 1),
          avg_clicks: round(avg(rows.map((r) => r.link_clicks)), 1),
        }))
        .sort((a, b) => b.avg_engagement_rate - a.avg_engagement_rate || cmp(a.segment, b.segment));
    },
  };
}

// Plain code-point order, same as Spark's string ORDER BY (localeCompare would differ).
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const promoRoi: QuerySpec = {
  id: "promo_roi",
  title: "Ad spend vs orders and revenue per promo code",
  columns: ["promo_code", "spend_xaf", "orders", "revenue_xaf", "roas", "cost_per_order_xaf"],
  keyColumn: "promo_code",
  textColumns: ["promo_code"],
  primaryMetric: "roas",
  segmentQuery: false,
  sql(period, usl) {
    assertPeriod(period);
    assertUsl(usl);
    return [
      "SELECT s.promo_code AS promo_code, s.spend_xaf AS spend_xaf,",
      "  COALESCE(o.orders, 0) AS orders, COALESCE(o.revenue_xaf, 0) AS revenue_xaf,",
      "  ROUND(COALESCE(o.revenue_xaf, 0) / s.spend_xaf, 2) AS roas,",
      "  CASE WHEN COALESCE(o.orders, 0) > 0 THEN ROUND(s.spend_xaf / o.orders, 0) ELSE NULL END AS cost_per_order_xaf",
      "FROM (SELECT promo_code, SUM(spend_xaf) AS spend_xaf",
      `  FROM ${usl}.campaign_daily WHERE ${dateFilter("ad_date", period)}`,
      "  GROUP BY promo_code) s",
      "LEFT JOIN (SELECT promo_code, COUNT(*) AS orders, SUM(amount_xaf) AS revenue_xaf",
      `  FROM ${usl}.orders WHERE ${dateFilter("order_date", period)} AND promo_code IS NOT NULL AND promo_code <> ''`,
      "  GROUP BY promo_code) o ON s.promo_code = o.promo_code",
      "WHERE s.spend_xaf > 0",
      "ORDER BY roas DESC, promo_code",
    ].join("\n");
  },
  compute(data, period) {
    assertPeriod(period);
    const spend = new Map<string, number>();
    for (const a of data.campaign_daily) {
      if (inPeriod(a.ad_date, period)) spend.set(a.promo_code, (spend.get(a.promo_code) ?? 0) + a.spend_xaf);
    }
    const sales = new Map<string, { orders: number; revenue: number }>();
    for (const o of data.orders) {
      if (!o.promo_code || !inPeriod(o.order_date, period)) continue;
      const s = sales.get(o.promo_code) ?? { orders: 0, revenue: 0 };
      sales.set(o.promo_code, { orders: s.orders + 1, revenue: s.revenue + o.amount_xaf });
    }
    return [...spend.entries()]
      .filter(([, s]) => s > 0)
      .map(([promo_code, spend_xaf]) => {
        const { orders, revenue } = sales.get(promo_code) ?? { orders: 0, revenue: 0 };
        return {
          promo_code,
          spend_xaf,
          orders,
          revenue_xaf: revenue,
          roas: round(revenue / spend_xaf, 2),
          cost_per_order_xaf: orders > 0 ? round(spend_xaf / orders, 0) : null,
        };
      })
      .sort((a, b) => b.roas - a.roas || cmp(a.promo_code, b.promo_code));
  },
};

const topPosts: QuerySpec = {
  id: "top_posts",
  title: "Top 5 posts by engagement rate",
  columns: ["post_id", "posted_date", "platform", "format", "pillar", "language", "origin", "reach", "engagements", "engagement_rate"],
  keyColumn: "post_id",
  textColumns: ["post_id", "posted_date", "platform", "format", "pillar", "language", "origin"],
  primaryMetric: "engagement_rate",
  segmentQuery: false,
  sql(period, usl) {
    assertPeriod(period);
    assertUsl(usl);
    return [
      "SELECT post_id, posted_date, platform, format, pillar, language, origin, reach, engagements,",
      "  ROUND(CAST(engagements AS DOUBLE) / reach, 4) AS engagement_rate",
      `FROM ${usl}.post_performance`,
      `WHERE ${dateFilter("posted_date", period)} AND ${VALID_SQL}`,
      "ORDER BY engagement_rate DESC, post_id",
      "LIMIT 5",
    ].join("\n");
  },
  compute(data, period) {
    assertPeriod(period);
    return data.post_performance
      .filter((r) => inPeriod(r.posted_date, period) && isValid(r))
      .map((r) => ({
        post_id: r.post_id,
        posted_date: r.posted_date,
        platform: r.platform,
        format: r.format,
        pillar: r.pillar,
        language: r.language,
        origin: r.origin,
        reach: r.reach,
        engagements: r.engagements,
        engagement_rate: round(engagementRate(r), 4),
      }))
      .sort((a, b) => b.engagement_rate - a.engagement_rate || cmp(a.post_id, b.post_id))
      .slice(0, 5);
  },
};

const dataQuality: QuerySpec = {
  id: "data_quality",
  title: "Posts excluded by the valid_metrics rule",
  columns: ["total_posts", "valid_posts", "invalid_posts"],
  keyColumn: null,
  textColumns: [],
  primaryMetric: "invalid_posts",
  segmentQuery: false,
  sql(period, usl) {
    assertPeriod(period);
    assertUsl(usl);
    // NULL metrics fall into the ELSE branch, i.e. count as invalid, matching the DQ rule.
    return [
      "SELECT COUNT(*) AS total_posts,",
      `  COALESCE(SUM(CASE WHEN ${VALID_SQL} THEN 1 ELSE 0 END), 0) AS valid_posts,`,
      `  COALESCE(SUM(CASE WHEN ${VALID_SQL} THEN 0 ELSE 1 END), 0) AS invalid_posts`,
      `FROM ${usl}.post_performance`,
      `WHERE ${dateFilter("posted_date", period)}`,
    ].join("\n");
  },
  compute(data, period) {
    assertPeriod(period);
    const rows = data.post_performance.filter((r) => inPeriod(r.posted_date, period));
    const valid = rows.filter(isValid).length;
    return [{ total_posts: rows.length, valid_posts: valid, invalid_posts: rows.length - valid }];
  },
};

export const CATALOGUE: readonly QuerySpec[] = [
  segmentQuery("format_performance", "Engagement by post format", "format", (r) => r.format),
  segmentQuery("pillar_performance", "Engagement by content pillar", "pillar", (r) => r.pillar),
  segmentQuery("language_performance", "Engagement by language", "language", (r) => r.language),
  segmentQuery(
    "timing_performance",
    "Engagement by time of day",
    "CASE WHEN post_hour < 12 THEN 'morning' WHEN post_hour < 18 THEN 'midday_afternoon' ELSE 'evening' END",
    (r) => (r.post_hour < 12 ? "morning" : r.post_hour < 18 ? "midday_afternoon" : "evening"),
  ),
  segmentQuery("platform_performance", "Engagement by platform", "platform", (r) => r.platform),
  // has_cta is a 'true'/'false' string in the USL table.
  segmentQuery(
    "cta_performance",
    "Engagement with vs without a call to action",
    "CASE WHEN lower(CAST(has_cta AS STRING)) = 'true' THEN 'cta_true' ELSE 'cta_false' END",
    (r) => (r.has_cta ? "cta_true" : "cta_false"),
  ),
  segmentQuery("origin_comparison", "Existing posts vs posts planned with GrowthLoop", "origin", (r) => r.origin),
  promoRoi,
  topPosts,
  dataQuality,
];

export function getQuery(id: string): QuerySpec | undefined {
  return CATALOGUE.find((q) => q.id === id);
}
