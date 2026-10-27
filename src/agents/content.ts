// Full mode: ContentCreator writes drafts for the plan, BrandReviewer checks them against
// hard brand rules, Publisher queues approved drafts in a local outbox (dry run only).
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Tracer } from "../trace.ts";
import { parseJson, type Llm } from "./ports.ts";
import type { BrandReview, Draft, PlanSlot, Produced } from "./types.ts";

export const MAX_POST_CHARS = 280;

export interface BrandProfile {
  name: string;
  whatsapp: string;
  dishes: readonly { name: string; price: number; promo_code?: string }[];
  hashtags: readonly string[];
}

// Synthetic client profile matching the generated sample data (same menu, prices and codes).
export const SAVEURS_DE_DOUALA: BrandProfile = {
  name: "Saveurs de Douala",
  whatsapp: "+237 690 00 00 00",
  dishes: [
    { name: "ndolé-plantain", price: 3500, promo_code: "NDOLE10" },
    { name: "poulet DG", price: 5000, promo_code: "POULETDG" },
    { name: "poisson braisé", price: 4500, promo_code: "WEEKEND15" },
    { name: "soya", price: 1000, promo_code: "SOYA500" },
    { name: "eru-water fufu", price: 3000 },
    { name: "koki", price: 1500 },
    { name: "formule étudiant (eru + jus de foléré)", price: 2500, promo_code: "RENTREE26" },
  ],
  hashtags: ["#Douala", "#Saveurs237"],
};

// ---------- BrandReviewer rules ----------

const SUPERLATIVES: readonly RegExp[] = [
  /\bbest\s+in\s+(douala|cameroon|cameroun|town|the city|africa)\b/i,
  /\bthe\s+best\b/i,
  /\b(number|num[eé]ro)\s*(1|one|un)\b/i,
  /\bn[°ºo]\.?\s*1\b/i,
  /#1\b/,
  // Lookahead, not \b: "à" is not a word character for \b, so "\b" after it never matches.
  /\bmeilleur(e|s|es)?\s+(de|du|des|au|à)(?=\s|$)/i,
  /\b(le|la|les)\s+meilleur(e|s|es)?\b/i,
  /\bgaranti(e|s|es)?\b/i,
  /\bguarantee[sd]?\b/i,
  /\b(unbeatable|imbattable)s?\b/i,
];
const FCFA_PRICE = /\d[\d\s.,  ]*\s?FCFA\b/i;
const OTHER_CURRENCY = /[€$£₦]|\b(EUR|USD|GBP|XAF|NGN|euros?|dollars?|naira)\b|(?<!F\s?)\bCFA\b/i;

/** The text that would actually be posted: caption plus hashtags. */
export const postText = (d: Pick<Draft, "caption" | "hashtags">) => [d.caption, ...d.hashtags].join(" ").trim();

/** Hard brand rules. Pure; returns one message per violation. */
export function checkBrandRules(draft: Pick<Draft, "caption" | "hashtags">): string[] {
  const issues: string[] = [];
  const text = postText(draft);
  if (text.length > MAX_POST_CHARS) issues.push(`Too long: ${text.length}/${MAX_POST_CHARS} characters (caption + hashtags).`);
  if (!/whatsapp/i.test(draft.caption)) issues.push("No WhatsApp call to action.");
  if (!FCFA_PRICE.test(draft.caption)) issues.push("No price in FCFA.");
  const currency = OTHER_CURRENCY.exec(text);
  if (currency) issues.push(`Currency other than FCFA: "${currency[0]}".`);
  for (const re of SUPERLATIVES) {
    const m = re.exec(text);
    if (m) issues.push(`Unprovable superlative: "${m[0]}".`);
  }
  return issues;
}

// ---------- ContentCreator ----------

const formatPrice = (xaf: number, language: string) =>
  String(xaf).replace(/\B(?=(\d{3})+(?!\d))/g, language === "en" ? "," : " ");

type Template = (dish: string, price: string, wa: string, code?: string) => string;

const TEMPLATES: Record<string, Record<string, Template>> = {
  fr: {
    menu: (d, p, wa) => `Aujourd'hui chez Saveurs de Douala : ${d}, préparé comme à la maison. Seulement ${p} FCFA. Commandez sur WhatsApp au ${wa}.`,
    promo: (d, p, wa, c) => `Promo de la semaine : ${d}${c ? ` avec le code ${c}` : ""}. Seulement ${p} FCFA. Commandez sur WhatsApp au ${wa}.`,
    behind_scenes: (d, p, wa) => `Ce matin au marché de Sandaga pour choisir les ingrédients du ${d}. ${p} FCFA le plat, commandez sur WhatsApp au ${wa}.`,
    customer_story: (d, p, wa) => `Paul vient chaque vendredi depuis Bonabéri pour notre ${d}. Merci pour la fidélité ! ${p} FCFA, commandez sur WhatsApp au ${wa}.`,
  },
  en: {
    menu: (d, p, wa) => `On the menu today: ${d}, cooked the Douala way. Only ${p} FCFA. Order on WhatsApp: ${wa}.`,
    promo: (d, p, wa, c) => `This week's deal: ${d}${c ? ` with code ${c}` : ""}. Only ${p} FCFA. Order on WhatsApp: ${wa}.`,
    behind_scenes: (d, p, wa) => `Early run to Sandaga market for today's ${d}. ${p} FCFA a plate, order on WhatsApp: ${wa}.`,
    customer_story: (d, p, wa) => `Grace orders our ${d} for her office every Friday. Thank you for the trust! ${p} FCFA, order on WhatsApp: ${wa}.`,
  },
  pidgin: {
    menu: (d, p, wa) => `${d} don ready for kitchen, come chop before e finish! Na only ${p} FCFA. Send we message for WhatsApp: ${wa}.`,
    promo: (d, p, wa, c) => `${c ? `Use code ${c} make you chop ${d} cheap cheap.` : `Deal of the week: ${d}.`} Na only ${p} FCFA. Send we message for WhatsApp: ${wa}.`,
    behind_scenes: (d, p, wa) => `We go Sandaga market early for buy correct thing for the ${d}. Na ${p} FCFA. Send we message for WhatsApp: ${wa}.`,
    customer_story: (d, p, wa) => `Mami Brenda say our ${d} sweet pass. Thank you! Na ${p} FCFA. Send we message for WhatsApp: ${wa}.`,
  },
};

function pickDish(slot: PlanSlot, index: number, brand: BrandProfile) {
  const withCode = slot.promo_code ? brand.dishes.find((d) => d.promo_code === slot.promo_code) : undefined;
  return withCode ?? brand.dishes[index % brand.dishes.length]!;
}

/** Template draft for one plan slot; always passes the brand rules (tested). */
export function templateDraft(slot: PlanSlot, index: number, brand: BrandProfile = SAVEURS_DE_DOUALA): Draft {
  const dish = pickDish(slot, index, brand);
  const byLanguage = TEMPLATES[slot.language] ?? TEMPLATES.fr!;
  const template = byLanguage[slot.pillar] ?? byLanguage.menu!;
  const code = slot.promo_code && dish.promo_code === slot.promo_code ? slot.promo_code : undefined;
  return {
    slot: index + 1,
    platform: slot.platform,
    format: slot.format,
    language: slot.language,
    post_hour: slot.post_hour,
    caption: template(dish.name, formatPrice(dish.price, slot.language), brand.whatsapp, code),
    hashtags: [...brand.hashtags],
  };
}

const CREATOR_SYSTEM = [
  "You are ContentCreator in GrowthLoop, writing social media posts for Saveurs de Douala, a food business in Douala, Cameroon.",
  "Write one post per plan slot, in the slot's language (fr = French, en = English, pidgin = Cameroonian Pidgin English).",
  `Hard rules: caption plus hashtags at most ${MAX_POST_CHARS} characters; a WhatsApp call to action with the number;`,
  "at least one real dish price written in FCFA (use the menu prices); FCFA is the only currency;",
  'no unprovable superlatives ("best in Douala", "number 1", "meilleur de Douala", "garanti"). Mention the promo code if the slot has one.',
  'Reply with JSON only: {"drafts":[{"slot":1,"caption":"...","hashtags":["#Douala"]}]}',
].join("\n");

const HASHTAG = /^#[\p{L}\p{N}_]{1,40}$/u;

/** Validate model drafts against the plan. Platform, format, language and hour always come from the plan. */
export function parseDrafts(text: string, plan: readonly PlanSlot[], slots?: ReadonlySet<number>): Map<number, Draft> {
  const out = new Map<number, Draft>();
  const parsed = parseJson<{ drafts?: unknown }>(text);
  if (!parsed || !Array.isArray(parsed.drafts)) return out;
  for (const raw of parsed.drafts as Record<string, unknown>[]) {
    const slot = raw?.slot;
    if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 1 || slot > plan.length || out.has(slot)) continue;
    if (slots && !slots.has(slot)) continue;
    if (typeof raw.caption !== "string" || raw.caption.trim().length < 10 || raw.caption.length > 600) continue;
    const hashtags = Array.isArray(raw.hashtags)
      ? raw.hashtags.filter((h): h is string => typeof h === "string" && HASHTAG.test(h)).slice(0, 6)
      : [];
    const p = plan[slot - 1]!;
    out.set(slot, {
      slot,
      platform: p.platform,
      format: p.format,
      language: p.language,
      post_hour: p.post_hour,
      caption: raw.caption.trim(),
      hashtags,
    });
  }
  return out;
}

export interface ContentOptions {
  llm: Llm;
  tracer: Tracer;
  brand?: BrandProfile;
}

const brandFacts = (brand: BrandProfile) =>
  [
    `Business: ${brand.name}. WhatsApp: ${brand.whatsapp}.`,
    `Menu: ${brand.dishes.map((d) => `${d.name} ${d.price} FCFA${d.promo_code ? ` (code ${d.promo_code})` : ""}`).join("; ")}.`,
    `Default hashtags: ${brand.hashtags.join(" ")}`,
  ].join("\n");

export async function createDrafts(plan: readonly PlanSlot[], opts: ContentOptions): Promise<Produced<Draft[]>> {
  const brand = opts.brand ?? SAVEURS_DE_DOUALA;
  const user = `${brandFacts(brand)}\n\nPlan:\n${plan.map((p, i) => JSON.stringify({ slot: i + 1, ...p })).join("\n")}`;
  const answer = await opts.llm({ agent: "ContentCreator", system: CREATOR_SYSTEM, user, maxTokens: 2000 });
  const fromModel = answer ? parseDrafts(answer.text, plan) : new Map<number, Draft>();
  const drafts = plan.map((slot, i) => fromModel.get(i + 1) ?? templateDraft(slot, i, brand));
  const templated = plan.length - fromModel.size;
  const model = answer && fromModel.size > 0 ? answer.model : null;

  opts.tracer.log({
    agent_name: "ContentCreator",
    action: "write_drafts",
    status: model ? "success" : "fallback",
    target_agent: "BrandReviewer",
    model,
    input_summary: `${plan.length}-post plan`,
    output_summary: model
      ? `${fromModel.size} drafts written by the model${templated ? `, ${templated} from templates (invalid model output)` : ""}`
      : `${answer ? `Model ${answer.model} reply unusable` : "No model available"}: ${drafts.length} template drafts`,
  });
  return { value: drafts, model };
}

const REVISE_SYSTEM = [
  "You are ContentCreator in GrowthLoop. The BrandReviewer rejected some drafts; fix every listed issue and keep the post's language and intent.",
  CREATOR_SYSTEM.split("\n").slice(2).join("\n"),
].join("\n");

/** One revision of the rejected drafts: model rewrite, or the rule-safe template. */
export async function reviseDrafts(
  drafts: readonly Draft[],
  reviews: readonly BrandReview[],
  plan: readonly PlanSlot[],
  opts: ContentOptions,
): Promise<Produced<Draft[]>> {
  const brand = opts.brand ?? SAVEURS_DE_DOUALA;
  const failing = reviews.filter((r) => !r.approved);
  if (failing.length === 0) return { value: [...drafts], model: null };
  const slots = new Set(failing.map((r) => r.slot));
  const payload = failing.map((r) => ({ slot: r.slot, draft: drafts.find((d) => d.slot === r.slot), issues: r.issues }));
  const answer = await opts.llm({ agent: "ContentCreator", system: REVISE_SYSTEM, user: `${brandFacts(brand)}\n\nRejected drafts:\n${JSON.stringify(payload)}`, maxTokens: 1500 });
  const fromModel = answer ? parseDrafts(answer.text, plan, slots) : new Map<number, Draft>();
  const revised = drafts.map((d) => (slots.has(d.slot) ? (fromModel.get(d.slot) ?? templateDraft(plan[d.slot - 1]!, d.slot - 1, brand)) : d));
  const model = answer && fromModel.size > 0 ? answer.model : null;

  opts.tracer.log({
    agent_name: "ContentCreator",
    action: "revise_drafts",
    status: model ? "success" : "fallback",
    target_agent: "BrandReviewer",
    model,
    retry_count: 1,
    input_summary: `drafts ${[...slots].join(", ")}: ${failing.flatMap((r) => r.issues).join(" ")}`,
    output_summary: model
      ? `${fromModel.size} rewritten by the model${slots.size - fromModel.size ? `, ${slots.size - fromModel.size} replaced by templates` : ""}`
      : `${answer ? `Model ${answer.model} reply unusable` : "No model available"}: ${slots.size} replaced by rule-safe templates`,
  });
  return { value: revised, model };
}

// ---------- BrandReviewer ----------

const TONE_SYSTEM = [
  "You are BrandReviewer for Saveurs de Douala, a friendly family food business in Douala.",
  "Hard rules (length, WhatsApp, FCFA, superlatives) were already checked. Review TONE only:",
  "warm, local and honest; no pressure tactics, no health or medical claims, no claims about competitors, nothing offensive.",
  'Reply with JSON only: {"reviews":[{"slot":1,"ok":true,"issue":""}]}',
].join("\n");

export interface ReviewOptions {
  llm: Llm;
  tracer: Tracer;
  /** 0 = first review, 1 = review after the single allowed revision. */
  round: number;
}

export async function reviewDrafts(drafts: readonly Draft[], opts: ReviewOptions): Promise<BrandReview[]> {
  const reviews: BrandReview[] = drafts.map((d) => {
    const issues = checkBrandRules(d);
    return { slot: d.slot, approved: issues.length === 0, issues };
  });

  // The model can only add tone issues to drafts that already pass the hard rules.
  const passing = drafts.filter((d) => reviews.find((r) => r.slot === d.slot)!.approved);
  let model: string | null = null;
  if (passing.length > 0) {
    const answer = await opts.llm({
      agent: "BrandReviewer",
      system: TONE_SYSTEM,
      user: JSON.stringify({ drafts: passing.map((d) => ({ slot: d.slot, language: d.language, caption: d.caption })) }),
      maxTokens: 800,
    });
    const parsed = answer ? parseJson<{ reviews?: unknown }>(answer.text) : null;
    const usable = Boolean(parsed && Array.isArray(parsed.reviews));
    model = answer?.model ?? null;
    if (usable) {
      for (const raw of parsed!.reviews as Record<string, unknown>[]) {
        const review = reviews.find((r) => r.slot === raw?.slot);
        if (review?.approved && raw.ok === false) {
          review.approved = false;
          review.issues.push(`Tone (model review): ${typeof raw.issue === "string" && raw.issue.trim() ? raw.issue.trim().slice(0, 200) : "no reason given"}`);
        }
      }
    }
    opts.tracer.log({
      agent_name: "BrandReviewer",
      action: "tone_review",
      status: usable ? "success" : "fallback",
      model,
      retry_count: opts.round,
      input_summary: `${passing.length} drafts that pass the hard rules`,
      output_summary: usable ? "tone checked" : model ? "Model reply was not valid JSON: rules only" : "No model available: rules only",
    });
  }

  const final = opts.round >= 1;
  for (const r of reviews) {
    opts.tracer.log({
      agent_name: "BrandReviewer",
      action: "review_draft",
      status: r.approved ? "success" : final ? "rejected" : "needs_revision",
      target_agent: r.approved ? "Publisher" : final ? null : "ContentCreator",
      model: r.issues.some((i) => i.startsWith("Tone (model review)")) ? model : null,
      retry_count: opts.round,
      input_summary: `draft ${r.slot}`,
      output_summary: r.approved ? `approved (<= ${MAX_POST_CHARS} chars, WhatsApp CTA, FCFA price)` : r.issues.join(" "),
    });
  }
  return reviews;
}

// ---------- Publisher ----------

const RUN_ID = /^[A-Za-z0-9_-]{1,80}$/;

export interface PublishInput {
  runId: string;
  client: string;
  drafts: readonly Draft[];
  reviews: readonly BrandReview[];
  outboxDir: string;
  tracer: Tracer;
  now?: () => Date;
}

/** DRY RUN: writes approved drafts to <outbox>/<run_id>.json. Never calls any network. */
export function publishDryRun(input: PublishInput): { file: string; queued: number; blocked: number } {
  if (!RUN_ID.test(input.runId)) throw new Error("Invalid run_id for the outbox file name");
  const approved = new Set(input.reviews.filter((r) => r.approved).map((r) => r.slot));
  const posts = input.drafts.filter((d) => approved.has(d.slot)).map((d) => ({ ...d, text: postText(d), status: "queued_dry_run" }));
  const blocked = input.reviews.filter((r) => !r.approved).map((r) => ({ slot: r.slot, issues: r.issues }));

  mkdirSync(input.outboxDir, { recursive: true });
  const path = join(input.outboxDir, `${input.runId}.json`);
  const body = {
    run_id: input.runId,
    client: input.client,
    created_at: (input.now ?? (() => new Date()))().toISOString(),
    status: "queued_dry_run",
    note: "Dry run: nothing was published to any social network.",
    posts,
    blocked,
  };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  const file = `${basename(input.outboxDir)}/${input.runId}.json`;

  input.tracer.log({
    agent_name: "Publisher",
    action: "write_outbox",
    status: "info",
    input_summary: `${input.drafts.length} drafts`,
    output_summary: `Dry run: ${posts.length} posts queued in ${file}${blocked.length ? `, ${blocked.length} blocked by BrandReviewer` : ""}; nothing published`,
  });
  return { file, queued: posts.length, blocked: blocked.length };
}
