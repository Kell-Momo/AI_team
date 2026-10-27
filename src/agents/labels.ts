// Human-readable names for data values, shared by the agents' deterministic texts.

export const LANGUAGE_NAMES: Record<string, string> = { fr: "French", en: "English", pidgin: "Pidgin" };
export const PILLAR_NAMES: Record<string, string> = {
  menu: "menu",
  promo: "promo",
  behind_scenes: "behind-the-scenes",
  customer_story: "customer story",
};
export const PLATFORM_NAMES: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  tiktok: "TikTok",
  whatsapp: "WhatsApp",
};
export const TIMING_NAMES: Record<string, string> = {
  morning: "morning (before 12:00)",
  midday_afternoon: "midday and afternoon (12:00 to 17:59)",
  evening: "evening (18:00 or later)",
};

export const label = (names: Record<string, string>, value: string) => names[value] ?? value.replace(/_/g, " ");
