// Display helpers; pure so they behave the same for mock and live data.

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "–";
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m} min ${s} s`;
}

export function formatHour(h: number): string {
  return `${String(h).padStart(2, "0")}:00`;
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Metric names carry the unit (…_rate, …_fcfa), so the value can be shown in a readable form.
export function formatMetricValue(metric: string, value: number | string): string {
  if (typeof value !== "number") return value;
  if (/rate|ratio_pct|share/.test(metric) && value <= 1) return `${(value * 100).toFixed(1)}%`;
  if (/fcfa/i.test(metric)) return `${value.toLocaleString("en")} FCFA`;
  return value.toLocaleString("en");
}

export function percent(n: number, total: number): string {
  return total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "0%";
}

export const LANGUAGE_NAMES: Record<string, string> = { fr: "French", en: "English", pidgin: "Pidgin" };
