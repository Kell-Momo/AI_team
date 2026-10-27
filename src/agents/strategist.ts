// Strategist: turns approved claims (+ recalled lessons) into recommendations and a 5-post plan.
import { FORMATS, LANGUAGES, PILLARS, PLATFORMS } from "../analytics/sample.ts";
import type { Tracer } from "../trace.ts";
import { label, LANGUAGE_NAMES, PILLAR_NAMES, PLATFORM_NAMES, TIMING_NAMES } from "./labels.ts";
import { parseJson, type Llm } from "./ports.ts";
import type { Claim, PlanSlot, Produced, Recommendation, Strategy } from "./types.ts";

export const AGENT = "Strategist";
export const PLAN_SIZE = 5;
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
// WhatsApp status is a posting channel even though the sample data has no metrics for it.
const PLAN_PLATFORMS = [...PLATFORMS, "whatsapp"] as const;
const PLAN_FORMATS = [...FORMATS, "video", "status"] as const;

export interface StrategistOptions {
  llm: Llm;
  tracer: Tracer;
  /** Who receives the plan: ContentCreator in full mode, MemoryKeeper in analyze mode. */
  nextAgent: string;
}

const SYSTEM = [
  "You are Strategist in GrowthLoop, the marketing team of Saveurs de Douala, a small food business in Douala, Cameroon.",
  "Using ONLY the verified claims (and the lessons from earlier runs as background), write:",
  "- a 2-3 sentence summary answering the question;",
  "- 3 to 5 recommendations, each citing the ids of the verified claims it relies on (claim_ids);",
  `- a plan of exactly ${PLAN_SIZE} posts for next week.`,
  `Allowed values: day in ${DAYS.join("/")}; platform in ${PLAN_PLATFORMS.join("/")}; format in ${PLAN_FORMATS.join("/")};`,
  `pillar in ${PILLARS.join("/")}; language in ${LANGUAGES.join("/")}; post_hour 0-23; promo_code optional (an existing code).`,
  'Reply with JSON only: {"summary":"...","recommendations":[{"action":"...","why":"...","claim_ids":["c1"]}],',
  '"plan":[{"day":"Monday","platform":"instagram","format":"reel","pillar":"menu","language":"fr","post_hour":19,"angle":"...","promo_code":"NDOLE10"}]}',
].join("\n");

const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const oneOf = (v: unknown, allowed: readonly string[]) =>
  typeof v === "string" && allowed.includes(v.toLowerCase()) ? v.toLowerCase() : null;

/** Strict validation of the model's strategy; null if anything essential is off. */
export function parseStrategy(text: string, claimIds: ReadonlySet<string>, promoCodes: ReadonlySet<string>): Strategy | null {
  const parsed = parseJson<Record<string, unknown>>(text);
  if (!parsed || typeof parsed !== "object") return null;
  const summary = str(parsed.summary, 800);
  if (!summary || !Array.isArray(parsed.recommendations) || !Array.isArray(parsed.plan)) return null;

  const recommendations: Recommendation[] = [];
  for (const raw of parsed.recommendations.slice(0, 6) as Record<string, unknown>[]) {
    const action = str(raw?.action, 300);
    const why = str(raw?.why, 400);
    // A recommendation must rest on at least one verified claim; unknown ids are dropped.
    const ids = Array.isArray(raw?.claim_ids) ? raw.claim_ids.filter((id): id is string => typeof id === "string" && claimIds.has(id)) : [];
    if (action && why && ids.length > 0) recommendations.push({ action, why, claim_ids: [...new Set(ids)] });
  }
  if (recommendations.length === 0) return null;

  if (parsed.plan.length !== PLAN_SIZE) return null;
  const plan: PlanSlot[] = [];
  for (const raw of parsed.plan as Record<string, unknown>[]) {
    const day = DAYS.find((d) => d.toLowerCase() === String(raw?.day ?? "").toLowerCase());
    const platform = oneOf(raw?.platform, PLAN_PLATFORMS);
    const format = oneOf(raw?.format, PLAN_FORMATS);
    const pillar = oneOf(raw?.pillar, PILLARS);
    const language = oneOf(raw?.language, LANGUAGES);
    const hour = raw?.post_hour;
    const angle = str(raw?.angle, 200);
    if (!day || !platform || !format || !pillar || !language || !angle) return null;
    if (typeof hour !== "number" || !Number.isInteger(hour) || hour < 0 || hour > 23) return null;
    const slot: PlanSlot = { day, platform, format, pillar, language, post_hour: hour, angle };
    const promo = typeof raw?.promo_code === "string" ? raw.promo_code.trim().toUpperCase() : "";
    if (promo && promoCodes.has(promo)) slot.promo_code = promo; // never invent a promo code
    plan.push(slot);
  }
  return { summary, recommendations, plan };
}

/** The winning segment of the first approved claim on a given query, if any. */
function winner(claims: readonly Claim[], query: string): { claim: Claim; segment: string } | null {
  const claim = claims.find((c) => c.evidence[0]?.query === query);
  return claim ? { claim, segment: claim.evidence[0]!.segment } : null;
}

const HOURS: Record<string, number[]> = { morning: [9, 10, 11, 9, 10], midday_afternoon: [12, 13, 14, 13, 12], evening: [19, 20, 18, 19, 20] };
const ANGLES: Record<string, string> = {
  menu: "Dish of the day close-up with its FCFA price",
  promo: "Weekly deal with the promo code and price",
  behind_scenes: "Early market run and cooking in the kitchen",
  customer_story: "A regular customer on why they keep coming back",
};

function recommendationFor(claim: Claim): Recommendation {
  const s = claim.evidence[0]!.segment;
  const q = claim.evidence[0]!.query;
  const second = claim.evidence[1]?.segment;
  const action: Record<string, string> = {
    format_performance: `Make ${s} the main format next week.`,
    pillar_performance: `Post more ${label(PILLAR_NAMES, s)} content.`,
    language_performance: `Write more posts in ${label(LANGUAGE_NAMES, s)}.`,
    timing_performance: `Schedule posts in the ${label(TIMING_NAMES, s)} slot.`,
    platform_performance: `Put more of the weekly posts on ${label(PLATFORM_NAMES, s)}.`,
    cta_performance: s === "cta_true" ? "Add a WhatsApp call to action to every post." : "Keep calls to action short and natural.",
    origin_comparison: s === "app" ? "Keep planning posts with GrowthLoop." : "Review what the planned posts changed compared with older ones.",
    promo_roi: `Move ad budget towards the ${s} campaign${second ? ` and review the ${second} campaign` : ""}.`,
  };
  return { action: action[q] ?? `Act on: ${claim.statement}`, why: claim.statement, claim_ids: [claim.id] };
}

/** Rule-based strategy from approved claims; also used when the model is unavailable. */
export function deterministicStrategy(question: string, approved: readonly Claim[], lessonCount: number): Strategy {
  const format = winner(approved, "format_performance")?.segment;
  const language = winner(approved, "language_performance")?.segment;
  const timing = winner(approved, "timing_performance")?.segment ?? "evening";
  const platform = winner(approved, "platform_performance")?.segment;
  const pillar = winner(approved, "pillar_performance")?.segment;
  const promo = winner(approved, "promo_roi")?.segment;

  const pillars = ["menu", "promo", "behind_scenes", "customer_story", "menu"];
  if (pillar && pillar !== "menu" && pillar !== "promo") pillars[4] = pillar; // best pillar twice
  const platforms = platform ? [platform, platform, "instagram", platform, "facebook"] : ["instagram", "facebook", "tiktok", "instagram", "facebook"];
  const languages = language ? [language, "fr", language, "fr", language] : ["fr", "pidgin", "en", "fr", "pidgin"];
  const formats = format ? [format, format, "carousel", format, "image"] : ["reel", "image", "carousel", "reel", "image"];
  const days = ["Monday", "Tuesday", "Thursday", "Friday", "Saturday"];
  const hours = HOURS[timing] ?? HOURS.evening!;

  const plan: PlanSlot[] = days.map((day, i) => {
    const slot: PlanSlot = {
      day,
      platform: platforms[i]!,
      format: formats[i]!,
      pillar: pillars[i]!,
      language: languages[i]!,
      post_hour: hours[i]!,
      angle: ANGLES[pillars[i]!]!,
    };
    if (slot.pillar === "promo" && promo) slot.promo_code = promo;
    return slot;
  });

  const recommendations = approved.slice(0, 5).map(recommendationFor);
  const summary =
    approved.length === 0
      ? `No claim passed the EvidenceCritic, so this plan uses safe defaults rather than findings. Question: ${question}`
      : `${approved.length} verified insight${approved.length === 1 ? "" : "s"} from this period. ` +
        `Strongest: ${approved[0]!.statement} The plan below applies them to next week's ${PLAN_SIZE} posts` +
        `${lessonCount > 0 ? `, with ${lessonCount} lesson${lessonCount === 1 ? "" : "s"} from earlier runs as background` : ""}.`;
  return { summary, recommendations, plan };
}

export async function planWeek(
  question: string,
  approved: readonly Claim[],
  memoryContext: string,
  lessonCount: number,
  promoCodes: ReadonlySet<string>,
  opts: StrategistOptions,
): Promise<Produced<Strategy>> {
  const input = `${approved.length} approved claims, ${lessonCount} recalled lessons`;
  if (approved.length > 0) {
    const user = [
      `Question: ${question}`,
      `Verified claims:\n${approved.map((c) => `${c.id}: ${c.statement}`).join("\n")}`,
      `Lessons from earlier runs:\n${memoryContext.trim() || "none"}`,
      `Existing promo codes: ${[...promoCodes].join(", ") || "none"}`,
    ].join("\n\n");
    const answer = await opts.llm({ agent: AGENT, system: SYSTEM, user, maxTokens: 2000 });
    const strategy = answer ? parseStrategy(answer.text, new Set(approved.map((c) => c.id)), promoCodes) : null;
    if (answer && strategy) {
      opts.tracer.log({
        agent_name: AGENT,
        action: "recommend_and_plan",
        status: "success",
        target_agent: opts.nextAgent,
        model: answer.model,
        input_summary: input,
        output_summary: `${strategy.recommendations.length} recommendations, ${strategy.plan.length}-post plan`,
      });
      return { value: strategy, model: answer.model };
    }
    const value = deterministicStrategy(question, approved, lessonCount);
    opts.tracer.log({
      agent_name: AGENT,
      action: "recommend_and_plan",
      status: "fallback",
      target_agent: opts.nextAgent,
      input_summary: input,
      output_summary: `${answer ? `Model ${answer.model} reply failed validation` : "No model available"}: rule-based ${value.recommendations.length} recommendations, ${value.plan.length}-post plan`,
    });
    return { value, model: null };
  }

  // Nothing verified: a model would only be guessing, so don't ask one.
  const value = deterministicStrategy(question, approved, lessonCount);
  opts.tracer.log({
    agent_name: AGENT,
    action: "recommend_and_plan",
    status: "fallback",
    target_agent: opts.nextAgent,
    input_summary: input,
    output_summary: "No verified claims: default plan, no recommendations",
  });
  return { value, model: null };
}
