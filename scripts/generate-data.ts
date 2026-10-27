// SYNTHETIC DATA. "Saveurs de Douala" is a fictional food business; no row here is real.
// Seeded and deterministic: the same seed always produces byte-identical CSVs.
// Patterns are planted on purpose so the agents have something true to find (see data/README.md).
//
// Usage: tsx scripts/generate-data.ts [--out <dir>] [--seed <int>]
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROJECT_ROOT } from "../src/config.ts";
import {
  CSV_COLUMNS,
  type Channel,
  type Format,
  type Language,
  type Origin,
  type Pillar,
  type Platform,
} from "../src/analytics/sample.ts";

const DEFAULT_SEED = 237; // Cameroon's dialling code

// ---------- args ----------

function parseArgs(argv: readonly string[]): { outDir: string; seed: number } {
  let outDir = join(PROJECT_ROOT, "data");
  let seed = DEFAULT_SEED;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--out" && value) {
      outDir = resolve(value);
      i++;
    } else if (flag === "--seed" && value && /^\d{1,9}$/.test(value)) {
      seed = Number(value);
      i++;
    } else {
      throw new Error(`Unknown or invalid argument: ${flag}. Usage: [--out <dir>] [--seed <int>]`);
    }
  }
  return { outDir, seed };
}

// ---------- seeded randomness ----------

// mulberry32: tiny, fast, good enough for synthetic data; Math.random can't be seeded.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(lo = 0, hi = 1): number {
    return lo + (hi - lo) * this.next();
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }
  weighted<T extends string>(weights: Readonly<Record<T, number>>): T {
    const entries = Object.entries(weights) as [T, number][];
    let roll = this.next() * entries.reduce((sum, [, w]) => sum + w, 0);
    for (const [value, w] of entries) {
      roll -= w;
      if (roll < 0) return value;
    }
    return entries[entries.length - 1]![0];
  }
  /** k distinct items, kept in original order. */
  sample<T>(items: readonly T[], k: number): T[] {
    const idx = items.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [idx[i], idx[j]] = [idx[j]!, idx[i]!];
    }
    return idx.slice(0, k).sort((x, y) => x - y).map((i) => items[i]!);
  }
  poisson(lambda: number): number {
    // Knuth; fine for the small daily order counts used here.
    const limit = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > limit);
    return k - 1;
  }
}

// ---------- calendar (all dates are local Douala dates, handled as UTC to avoid DST/offset drift) ----------

const DAY_MS = 86_400_000;
const day = (month: number, d: number) => Date.UTC(2026, month - 1, d);
const START = day(7, 1);
const END = day(10, 20);
const APP_START = day(9, 16); // first day the app publishes; earlier posts are the audit set
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const range = (from: number, to: number) => {
  const out: number[] = [];
  for (let t = from; t <= to; t += DAY_MS) out.push(t);
  return out;
};
const pad = (n: number, width: number) => String(n).padStart(width, "0");

// ---------- business catalogue ----------

interface Dish {
  name: string;
  price: number;
}

const DISHES = {
  ndole: { name: "ndolé-plantain", price: 3500 },
  poulet_dg: { name: "poulet DG", price: 5000 },
  poisson: { name: "poisson braisé", price: 4500 },
  soya: { name: "soya", price: 1000 },
  eru: { name: "eru-water fufu", price: 3000 },
  koki: { name: "koki", price: 1500 },
  bhb: { name: "beignets-haricots-bouillie", price: 1000 },
  formule: { name: "formule étudiant (eru + jus de foléré)", price: 2500 },
} as const satisfies Record<string, Dish>;
type DishKey = keyof typeof DISHES;
const MENU_DISHES: readonly DishKey[] = ["ndole", "poulet_dg", "poisson", "soya", "eru", "koki", "bhb"];

interface Campaign {
  id: string;
  code: string;
  platform: Platform;
  start: number;
  end: number;
  dish: DishKey;
  dailySpend: number;
  /** Planted revenue per FCFA spent; deliberately very different across codes. */
  roas: number;
  avgOrder: number;
  weekendsOnly?: boolean;
}

// Each promo code belongs to exactly one campaign.
const CAMPAIGNS: readonly Campaign[] = [
  { id: "CMP-2607-NDOLE", code: "NDOLE10", platform: "facebook", start: day(7, 1), end: day(7, 31), dish: "ndole", dailySpend: 8000, roas: 3.2, avgOrder: 4000 },
  { id: "CMP-2607-SOYA", code: "SOYA500", platform: "instagram", start: day(7, 15), end: day(8, 20), dish: "soya", dailySpend: 10000, roas: 1.1, avgOrder: 2500 },
  { id: "CMP-2608-WKND", code: "WEEKEND15", platform: "facebook", start: day(8, 1), end: day(9, 15), dish: "poisson", dailySpend: 7000, roas: 2.3, avgOrder: 6000, weekendsOnly: true },
  { id: "CMP-2609-DG", code: "POULETDG", platform: "tiktok", start: day(9, 1), end: day(10, 20), dish: "poulet_dg", dailySpend: 9000, roas: 4.6, avgOrder: 5500 },
  { id: "CMP-2609-RENTREE", code: "RENTREE26", platform: "instagram", start: day(9, 16), end: day(10, 20), dish: "formule", dailySpend: 12000, roas: 0.7, avgOrder: 3000 },
];
const isWeekend = (ms: number) => [0, 5, 6].includes(new Date(ms).getUTCDay()); // Fri-Sun
const campaignRuns = (c: Campaign, ms: number) => ms >= c.start && ms <= c.end && (!c.weekendsOnly || isWeekend(ms));

// ---------- captions ----------

// Not toLocaleString: ICU data differs between Node builds and would break byte-identical output.
const formatPrice = (xaf: number, lang: Language) =>
  String(xaf).replace(/\B(?=(\d{3})+(?!\d))/g, lang === "en" ? "," : " ");

const OPENERS: Record<Language, Record<Pillar, readonly ((dish: string, code: string) => string)[]>> = {
  fr: {
    menu: [
      (d) => `Aujourd'hui chez Saveurs de Douala : ${d}, préparé comme à la maison.`,
      (d) => `Le plat du jour, c'est ${d}. Venez tôt, ça part vite à Akwa !`,
    ],
    promo: [
      (d, c) => `Promo de la semaine : ${d} avec le code ${c}.`,
      (d, c) => `Bonne nouvelle : avec le code ${c}, votre ${d} coûte moins cher.`,
    ],
    behind_scenes: [
      (d) => `En cuisine dès 6h : on prépare le ${d} à la main. Rien n'est surgelé.`,
      (d) => `Au marché de Sandaga ce matin pour choisir les ingrédients du ${d}.`,
    ],
    customer_story: [
      (d) => `Une cliente de Bonapriso nous écrit : "le meilleur ${d} de Douala". Merci !`,
      (d) => `Paul vient chaque vendredi depuis Bonabéri pour notre ${d}. Merci pour la fidélité !`,
    ],
  },
  en: {
    menu: [
      (d) => `On the menu today: ${d}, cooked the Douala way.`,
      (d) => `Today's special is ${d}. Come early, it goes fast!`,
    ],
    promo: [
      (d, c) => `This week's deal: ${d} with code ${c}.`,
      (d, c) => `Use code ${c} and save on your ${d}.`,
    ],
    behind_scenes: [
      (d) => `Kitchen starts at 6am: fresh ingredients, no shortcuts for our ${d}.`,
      (d) => `Early run to Sandaga market to pick what goes into today's ${d}.`,
    ],
    customer_story: [
      (d) => `A customer from Bonamoussadi says our ${d} tastes like "mami's own". Thank you!`,
      (d) => `Grace orders our ${d} for her office every Friday. Thank you for the trust!`,
    ],
  },
  pidgin: {
    menu: [
      (d) => `Today na ${d} for Saveurs de Douala, e sweet die!`,
      (d) => `${d} don ready for kitchen, come chop before e finish!`,
    ],
    promo: [
      (d, c) => `Promo don land: ${d} with code ${c}, no dull yourself.`,
      (d, c) => `Use code ${c} make you chop ${d} cheap cheap.`,
    ],
    behind_scenes: [
      (d) => `We dey kitchen since 6am for prepare the ${d}. Na fresh fresh.`,
      (d) => `We go Sandaga market early for buy correct thing for the ${d}.`,
    ],
    customer_story: [
      (d) => `Our customer for Makepe talk say our ${d} na "number one". Thank you plenty!`,
      (d) => `Mama Brenda for Deido no dey miss our ${d} every Sunday. We thank you!`,
    ],
  },
};

const PRICE_LINE: Record<Language, (p: string) => string> = {
  fr: (p) => `Seulement ${p} FCFA.`,
  en: (p) => `Only ${p} FCFA.`,
  pidgin: (p) => `Na only ${p} FCFA.`,
};

const CTA_LINE: Record<Language, string> = {
  fr: "Commandez sur WhatsApp, livraison à Akwa, Bonapriso et Bonamoussadi.",
  en: "Order on WhatsApp, delivery across Douala.",
  pidgin: "Send we message for WhatsApp, we go deliver for your side.",
};

const MAX_CAPTION = 280;

function buildCaption(rng: Rng, lang: Language, pillar: Pillar, dish: Dish, code: string, hasPrice: boolean, hasCta: boolean): string {
  const parts = [rng.pick(OPENERS[lang][pillar])(dish.name, code)];
  if (hasPrice) parts.push(PRICE_LINE[lang](formatPrice(dish.price, lang)));
  if (hasCta) parts.push(CTA_LINE[lang]);
  parts.push("#Douala #Saveurs237");
  const caption = parts.join(" ");
  if (caption.length > MAX_CAPTION) throw new Error(`Caption over ${MAX_CAPTION} chars: ${caption}`);
  return caption;
}

// ---------- posts + metrics ----------

interface Post {
  post_id: string;
  posted_at: string;
  platform: Platform;
  format: Format;
  pillar: Pillar;
  language: Language;
  post_hour: number;
  has_price: boolean;
  has_cta: boolean;
  origin: Origin;
  promo_code: string;
  caption: string;
}

interface Metric {
  post_id: string;
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  link_clicks: number;
}

// Content habits before vs after the app: the app leans into what the planted effects reward.
const HABITS: Record<Origin, {
  posts: number;
  format: Record<Format, number>;
  pillar: Record<Pillar, number>;
  language: Record<Language, number>;
  evening: number;
  price: number;
  cta: number;
}> = {
  existing: {
    posts: 65,
    format: { image: 45, carousel: 20, reel: 15, text: 20 },
    pillar: { menu: 40, promo: 30, behind_scenes: 15, customer_story: 15 },
    language: { fr: 60, en: 25, pidgin: 15 },
    evening: 0.3,
    price: 0.4,
    cta: 0.35,
  },
  app: {
    posts: 30,
    format: { image: 20, carousel: 30, reel: 45, text: 5 },
    pillar: { menu: 25, promo: 20, behind_scenes: 30, customer_story: 25 },
    language: { fr: 40, en: 15, pidgin: 45 },
    evening: 0.75,
    price: 0.75,
    cta: 0.9,
  },
};

// Planted effects (multipliers on the base rates).
const BASE_REACH: Record<Platform, number> = { facebook: 1200, instagram: 900, tiktok: 2000 };
const REACH_BY_FORMAT: Record<Format, number> = { reel: 1.8, carousel: 1.2, image: 1.0, text: 0.6 };
const BASE_ENGAGEMENT_RATE = 0.04;
const ENG_BY_FORMAT: Record<Format, number> = { reel: 1.5, carousel: 1.2, image: 1.0, text: 0.7 };
const ENG_BY_LANGUAGE: Record<Language, number> = { pidgin: 1.35, fr: 1.0, en: 0.85 };
const ENG_BY_PILLAR: Record<Pillar, number> = { behind_scenes: 1.4, customer_story: 1.2, menu: 1.0, promo: 0.85 };
const ENG_EVENING = 1.4; // 18:00-21:59
const BASE_CLICK_RATE = 0.004;
const CLICKS_WITH_CTA = 3;
const CLICKS_WITH_PRICE = 2;

const EVENING_HOURS = [18, 19, 20, 21];
const DAY_HOURS = [8, 9, 10, 11, 12, 13, 14, 15];
const BROKEN_METRIC_ROWS = 3;

function generatePosts(rng: Rng): { posts: Post[]; metrics: Metric[]; brokenIds: string[] } {
  const schedule: [number, Origin][] = [
    ...rng.sample(range(START, APP_START - DAY_MS), HABITS.existing.posts).map((t): [number, Origin] => [t, "existing"]),
    ...rng.sample(range(APP_START, END), HABITS.app.posts).map((t): [number, Origin] => [t, "app"]),
  ];

  const posts: Post[] = [];
  const metrics: Metric[] = [];

  schedule.forEach(([ms, origin], i) => {
    const habits = HABITS[origin];
    const format = rng.weighted(habits.format);
    // Text posts only make sense on Facebook; reels live mostly on TikTok/Instagram.
    const platform: Platform =
      format === "text" ? "facebook"
      : format === "reel" ? rng.weighted<Platform>({ tiktok: 50, instagram: 35, facebook: 15 })
      : rng.weighted<Platform>({ facebook: 50, instagram: 50, tiktok: 0 });
    const language = rng.weighted(habits.language);
    const evening = rng.chance(habits.evening);
    const hour = rng.pick(evening ? EVENING_HOURS : DAY_HOURS);
    const minute = rng.pick([0, 15, 30, 45]);

    let pillar = rng.weighted(habits.pillar);
    const active = CAMPAIGNS.filter((c) => ms >= c.start && ms <= c.end);
    if (pillar === "promo" && active.length === 0) pillar = "menu";
    const campaign = pillar === "promo" ? rng.pick(active) : undefined;
    const dish = DISHES[campaign ? campaign.dish : rng.pick(MENU_DISHES)];
    const hasPrice = pillar === "promo" || rng.chance(habits.price);
    const hasCta = rng.chance(habits.cta);

    const post_id = `P${pad(i + 1, 3)}`;
    posts.push({
      post_id,
      posted_at: `${isoDate(ms)} ${pad(hour, 2)}:${pad(minute, 2)}:00`,
      platform,
      format,
      pillar,
      language,
      post_hour: hour,
      has_price: hasPrice,
      has_cta: hasCta,
      origin,
      promo_code: campaign?.code ?? "",
      caption: buildCaption(rng, language, pillar, dish, campaign?.code ?? "", hasPrice, hasCta),
    });

    const reach = Math.max(150, Math.round(BASE_REACH[platform] * REACH_BY_FORMAT[format] * rng.float(0.7, 1.35)));
    const rate =
      BASE_ENGAGEMENT_RATE * ENG_BY_FORMAT[format] * ENG_BY_LANGUAGE[language] * ENG_BY_PILLAR[pillar] *
      (evening ? ENG_EVENING : 1) * rng.float(0.75, 1.3);
    const engagements = reach * rate;
    const clickRate =
      BASE_CLICK_RATE * (hasCta ? CLICKS_WITH_CTA : 1) * (hasPrice ? CLICKS_WITH_PRICE : 1) * rng.float(0.7, 1.3);
    metrics.push({
      post_id,
      reach,
      likes: Math.max(1, Math.round(engagements * rng.float(0.62, 0.74))),
      comments: Math.round(engagements * rng.float(0.08, 0.16)),
      shares: Math.round(engagements * rng.float(0.06, 0.13)),
      saves: Math.round(engagements * rng.float(0.04, 0.1)),
      link_clicks: Math.round(reach * clickRate),
    });
  });

  // Plant data-entry glitches for the Zetaris DQ rule (reach > 0 AND engagements <= reach).
  const broken = rng.sample(metrics, BROKEN_METRIC_ROWS);
  broken.forEach((row, k) => {
    const engagements = row.likes + row.comments + row.shares + row.saves;
    row.reach = k === 0 ? 0 : Math.floor(engagements * 0.5);
  });

  return { posts, metrics, brokenIds: broken.map((r) => r.post_id) };
}

// ---------- ads + sales ----------

interface AdRow {
  ad_date: string;
  campaign_id: string;
  platform: Platform;
  spend_xaf: number;
  impressions: number;
  clicks: number;
  promo_code: string;
}

interface OrderRow {
  order_id: string;
  order_date: string;
  channel: Channel;
  promo_code: string;
  amount_xaf: number;
}

const roundTo500 = (x: number) => Math.max(500, Math.round(x / 500) * 500);

function generateAdsAndSales(rng: Rng): { ads: AdRow[]; orders: OrderRow[] } {
  const ads: AdRow[] = [];
  const orders: OrderRow[] = [];
  const addOrder = (ms: number, channel: Channel, promo_code: string, amount_xaf: number) =>
    orders.push({ order_id: `O${pad(orders.length + 1, 5)}`, order_date: isoDate(ms), channel, promo_code, amount_xaf });

  for (const ms of range(START, END)) {
    // Walk-in and organic orders: steady baseline, slightly higher once the app is posting.
    const organic = rng.poisson(ms >= APP_START ? 12 : 9);
    for (let k = 0; k < organic; k++) {
      const dish = DISHES[rng.pick(MENU_DISHES)];
      const drink = rng.chance(0.4) ? 500 : 0;
      addOrder(ms, rng.weighted<Channel>({ whatsapp: 55, walk_in: 30, phone: 15 }), "", dish.price * rng.int(1, 3) + drink);
    }

    for (const c of CAMPAIGNS) {
      if (!campaignRuns(c, ms)) continue;
      const spend = roundTo500(c.dailySpend * rng.float(0.75, 1.25));
      const impressions = Math.round(spend * rng.float(0.9, 1.4));
      ads.push({
        ad_date: isoDate(ms),
        campaign_id: c.id,
        platform: c.platform,
        spend_xaf: spend,
        impressions,
        clicks: Math.round(impressions * rng.float(0.008, 0.03)),
        promo_code: c.code,
      });
      // Orders scale with spend at the campaign's planted return.
      const promoOrders = rng.poisson((spend * c.roas) / c.avgOrder);
      for (let k = 0; k < promoOrders; k++) {
        addOrder(ms, rng.weighted<Channel>({ whatsapp: 80, phone: 15, walk_in: 5 }), c.code, roundTo500(c.avgOrder * rng.float(0.5, 1.5)));
      }
    }
  }
  return { ads, orders };
}

// ---------- CSV ----------

function csvField(value: string | number | boolean): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv<T extends object>(columns: readonly (keyof T & string)[], rows: readonly T[]): string {
  const lines = [columns.join(","), ...rows.map((r) => columns.map((c) => csvField(r[c] as string | number | boolean)).join(","))];
  // LF on every OS so output is byte-identical everywhere.
  return `${lines.join("\n")}\n`;
}

// ---------- main ----------

function main(): void {
  const { outDir, seed } = parseArgs(process.argv.slice(2));
  // Separate streams per table so changing one generator doesn't reshuffle the others.
  const { posts, metrics, brokenIds } = generatePosts(new Rng(seed));
  const { ads, orders } = generateAdsAndSales(new Rng(seed + 1));

  const files: Record<string, string> = {
    "posts.csv": toCsv<Post>(CSV_COLUMNS.posts, posts),
    "post_metrics.csv": toCsv<Metric>(CSV_COLUMNS.post_metrics, metrics),
    "ad_spend.csv": toCsv<AdRow>(CSV_COLUMNS.ad_spend, ads),
    "sales.csv": toCsv<OrderRow>(CSV_COLUMNS.sales, orders),
  };

  mkdirSync(outDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(outDir, name), content, "utf8");

  console.log(`Synthetic data for "Saveurs de Douala" (seed ${seed}) -> ${outDir}`);
  console.log(`  posts.csv         ${posts.length} rows (${posts.filter((p) => p.origin === "existing").length} existing, ${posts.filter((p) => p.origin === "app").length} app)`);
  console.log(`  post_metrics.csv  ${metrics.length} rows (planted invalid: ${brokenIds.join(", ")})`);
  console.log(`  ad_spend.csv      ${ads.length} rows across ${CAMPAIGNS.length} campaigns`);
  console.log(`  sales.csv         ${orders.length} rows (${orders.filter((o) => o.promo_code !== "").length} with a promo code)`);
}

main();
