// SAMPLE_MODE data source: reads the local CSVs and builds in memory the same joined
// tables the agents otherwise query from Zetaris (post_performance, campaign_daily, orders).
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PLATFORMS = ["facebook", "instagram", "tiktok"] as const;
export const FORMATS = ["image", "carousel", "reel", "text"] as const;
export const PILLARS = ["menu", "promo", "behind_scenes", "customer_story"] as const;
export const LANGUAGES = ["fr", "en", "pidgin"] as const;
export const ORIGINS = ["existing", "app"] as const;
export const CHANNELS = ["whatsapp", "walk_in", "phone"] as const;

export type Platform = (typeof PLATFORMS)[number];
export type Format = (typeof FORMATS)[number];
export type Pillar = (typeof PILLARS)[number];
export type Language = (typeof LANGUAGES)[number];
export type Origin = (typeof ORIGINS)[number];
export type Channel = (typeof CHANNELS)[number];

export const CSV_COLUMNS = {
  posts: [
    "post_id", "posted_at", "platform", "format", "pillar", "language", "post_hour",
    "has_price", "has_cta", "origin", "promo_code", "caption",
  ],
  post_metrics: ["post_id", "reach", "likes", "comments", "shares", "saves", "link_clicks"],
  ad_spend: ["ad_date", "campaign_id", "platform", "spend_xaf", "impressions", "clicks", "promo_code"],
  sales: ["order_id", "order_date", "channel", "promo_code", "amount_xaf"],
} as const;

export interface PostPerformanceRow {
  post_id: string;
  posted_at: string;
  /** YYYY-MM-DD, local Douala date. */
  posted_date: string;
  platform: Platform;
  format: Format;
  pillar: Pillar;
  language: Language;
  post_hour: number;
  has_price: boolean;
  has_cta: boolean;
  origin: Origin;
  promo_code: string | null;
  caption: string;
  reach: number;
  /** likes + comments + shares + saves */
  engagements: number;
  link_clicks: number;
}

export interface CampaignDailyRow {
  ad_date: string;
  campaign_id: string;
  platform: Platform;
  spend_xaf: number;
  impressions: number;
  clicks: number;
  promo_code: string;
}

export interface OrderRow {
  order_id: string;
  order_date: string;
  channel: Channel;
  promo_code: string | null;
  amount_xaf: number;
}

export interface SampleData {
  post_performance: PostPerformanceRow[];
  campaign_daily: CampaignDailyRow[];
  orders: OrderRow[];
}

export class SampleDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SampleDataError";
  }
}

/** RFC 4180 CSV: quoted fields, "" escapes, commas/newlines inside quotes, LF or CRLF. */
export function parseCsv(text: string): string[][] {
  // Excel likes to prepend a BOM; it would otherwise end up in the first column name.
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let quoted = false; // current field was quoted (so an empty "" field still counts)
  let afterQuote = false; // just closed a quote: only a separator may follow
  let line = 1;

  const endField = () => {
    row.push(field);
    field = "";
    quoted = false;
    afterQuote = false;
  };
  const endRow = () => {
    const blank = row.length === 0 && field === "" && !quoted;
    endField();
    if (!blank) rows.push(row);
    row = [];
  };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === ",") {
      endField();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      endRow();
      line++;
    } else if (afterQuote) {
      throw new SampleDataError(`CSV line ${line}: unexpected character after closing quote`);
    } else if (ch === '"') {
      if (field !== "") throw new SampleDataError(`CSV line ${line}: quote inside an unquoted field`);
      inQuotes = true;
      quoted = true;
    } else {
      field += ch;
    }
  }
  if (inQuotes) throw new SampleDataError(`CSV line ${line}: unterminated quoted field`);
  if (field !== "" || quoted || row.length > 0) endRow();
  return rows;
}

type Rec = Readonly<Record<string, string>>;

/** Parse a CSV with a header row into records, checking the header and every row's width. */
export function parseCsvRecords(text: string, expected: readonly string[], source: string): Rec[] {
  const [header, ...body] = parseCsv(text);
  if (!header) throw new SampleDataError(`${source}: empty file`);
  const missing = expected.filter((c) => !header.includes(c));
  if (missing.length > 0) throw new SampleDataError(`${source}: missing columns ${missing.join(", ")}`);
  return body.map((cells, i) => {
    if (cells.length !== header.length) {
      throw new SampleDataError(`${source} row ${i + 2}: expected ${header.length} fields, got ${cells.length}`);
    }
    return Object.fromEntries(header.map((name, j) => [name, cells[j]!]));
  });
}

// Strict coercion: a malformed value is a data bug we want to see, not silently zero.
class Reader {
  constructor(private readonly source: string) {}

  private fail(row: number, col: string, why: string): never {
    throw new SampleDataError(`${this.source} row ${row + 2}, ${col}: ${why}`);
  }
  str(r: Rec, i: number, col: string): string {
    const v = r[col];
    if (v === undefined || v === "") this.fail(i, col, "required");
    return v;
  }
  nullable(r: Rec, i: number, col: string): string | null {
    const v = r[col];
    return v === undefined || v === "" ? null : v;
  }
  int(r: Rec, i: number, col: string): number {
    const v = this.str(r, i, col);
    if (!/^-?\d+$/.test(v)) this.fail(i, col, `not an integer: ${v}`);
    return Number(v);
  }
  bool(r: Rec, i: number, col: string): boolean {
    const v = this.str(r, i, col);
    if (v !== "true" && v !== "false") this.fail(i, col, `not true/false: ${v}`);
    return v === "true";
  }
  date(r: Rec, i: number, col: string): string {
    const v = this.str(r, i, col);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) this.fail(i, col, `not YYYY-MM-DD: ${v}`);
    return v;
  }
  oneOf<T extends string>(r: Rec, i: number, col: string, allowed: readonly T[]): T {
    const v = this.str(r, i, col);
    if (!(allowed as readonly string[]).includes(v)) this.fail(i, col, `unexpected value: ${v}`);
    return v as T;
  }
}

function readCsvFile(dataDir: string, file: string, expected: readonly string[]): Rec[] {
  let text: string;
  try {
    text = readFileSync(join(dataDir, file), "utf8");
  } catch {
    throw new SampleDataError(`Cannot read ${file} in ${dataDir}. Run: npm run data:generate`);
  }
  return parseCsvRecords(text, expected, file);
}

export function loadSampleData(dataDir: string): SampleData {
  const posts = readCsvFile(dataDir, "posts.csv", CSV_COLUMNS.posts);
  const metrics = readCsvFile(dataDir, "post_metrics.csv", CSV_COLUMNS.post_metrics);
  const ads = readCsvFile(dataDir, "ad_spend.csv", CSV_COLUMNS.ad_spend);
  const sales = readCsvFile(dataDir, "sales.csv", CSV_COLUMNS.sales);

  const m = new Reader("post_metrics.csv");
  const metricsById = new Map<string, { reach: number; engagements: number; link_clicks: number }>();
  metrics.forEach((r, i) => {
    const id = m.str(r, i, "post_id");
    if (metricsById.has(id)) throw new SampleDataError(`post_metrics.csv: duplicate post_id ${id}`);
    metricsById.set(id, {
      reach: m.int(r, i, "reach"),
      engagements: m.int(r, i, "likes") + m.int(r, i, "comments") + m.int(r, i, "shares") + m.int(r, i, "saves"),
      link_clicks: m.int(r, i, "link_clicks"),
    });
  });

  const p = new Reader("posts.csv");
  const seen = new Set<string>();
  const post_performance = posts.map((r, i): PostPerformanceRow => {
    const post_id = p.str(r, i, "post_id");
    if (seen.has(post_id)) throw new SampleDataError(`posts.csv: duplicate post_id ${post_id}`);
    seen.add(post_id);
    const metric = metricsById.get(post_id);
    // Strict join: a post without metrics (or vice versa) would skew every rate silently.
    if (!metric) throw new SampleDataError(`posts.csv: post ${post_id} has no row in post_metrics.csv`);
    const posted_at = p.str(r, i, "posted_at");
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(posted_at)) {
      throw new SampleDataError(`posts.csv row ${i + 2}, posted_at: not "YYYY-MM-DD HH:MM:SS"`);
    }
    return {
      post_id,
      posted_at,
      posted_date: posted_at.slice(0, 10),
      platform: p.oneOf(r, i, "platform", PLATFORMS),
      format: p.oneOf(r, i, "format", FORMATS),
      pillar: p.oneOf(r, i, "pillar", PILLARS),
      language: p.oneOf(r, i, "language", LANGUAGES),
      post_hour: p.int(r, i, "post_hour"),
      has_price: p.bool(r, i, "has_price"),
      has_cta: p.bool(r, i, "has_cta"),
      origin: p.oneOf(r, i, "origin", ORIGINS),
      promo_code: p.nullable(r, i, "promo_code"),
      caption: p.str(r, i, "caption"),
      ...metric,
    };
  });
  for (const id of metricsById.keys()) {
    if (!seen.has(id)) throw new SampleDataError(`post_metrics.csv: post ${id} not found in posts.csv`);
  }

  const a = new Reader("ad_spend.csv");
  const campaign_daily = ads.map((r, i): CampaignDailyRow => ({
    ad_date: a.date(r, i, "ad_date"),
    campaign_id: a.str(r, i, "campaign_id"),
    platform: a.oneOf(r, i, "platform", PLATFORMS),
    spend_xaf: a.int(r, i, "spend_xaf"),
    impressions: a.int(r, i, "impressions"),
    clicks: a.int(r, i, "clicks"),
    promo_code: a.str(r, i, "promo_code"),
  }));

  const s = new Reader("sales.csv");
  const orders = sales.map((r, i): OrderRow => ({
    order_id: s.str(r, i, "order_id"),
    order_date: s.date(r, i, "order_date"),
    channel: s.oneOf(r, i, "channel", CHANNELS),
    promo_code: s.nullable(r, i, "promo_code"),
    amount_xaf: s.int(r, i, "amount_xaf"),
  }));

  return { post_performance, campaign_daily, orders };
}
