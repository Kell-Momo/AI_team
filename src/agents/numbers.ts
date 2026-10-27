// Numbers inside claim statements. The critic checks each one against the evidence; the
// analyst's deterministic repair recomputes them from the actual values.

export const TOLERANCE = 0.03;

export type NumberKind = "percent" | "decimal" | "money";

export interface StatementNumber {
  kind: NumberKind;
  value: number;
  /** Position of the numeric part only (not the % or FCFA suffix). */
  start: number;
  end: number;
  decimals: number;
}

// Thousands-separated money ("1,284,000" / "3 500") or a plain number with optional decimals.
const NUMBER = /(?<![\d.,])(\d{1,3}(?:[ ,  ]\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?)(\s*%|\s*(?:FCFA|XAF)\b)?/gi;

/**
 * Numbers worth checking: percentages, decimals and FCFA amounts. Plain integers (post counts,
 * hours, years, "top 5") are left out: they are too ambiguous to verify reliably.
 */
export function extractNumbers(statement: string): StatementNumber[] {
  const out: StatementNumber[] = [];
  for (const m of statement.matchAll(NUMBER)) {
    const raw = m[1]!;
    const suffix = (m[2] ?? "").trim().toUpperCase();
    const thousands = /^\d{1,3}([ ,  ]\d{3})+/.test(raw) && !/^\d+,\d{1,2}$/.test(raw);
    const normalised = thousands ? raw.replace(/[ ,  ]/g, "") : raw.replace(",", ".");
    const value = Number(normalised);
    if (!Number.isFinite(value)) continue;
    const decimals = normalised.includes(".") ? normalised.split(".")[1]!.length : 0;
    const kind: NumberKind | null =
      suffix === "%" ? "percent" : suffix === "FCFA" || suffix === "XAF" ? "money" : decimals > 0 ? "decimal" : null;
    if (kind) out.push({ kind, value, start: m.index!, end: m.index! + raw.length, decimals });
  }
  return out;
}

export function close(x: number, target: number, tolerance = TOLERANCE): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(target)) return false;
  if (target === 0) return Math.abs(x) < 1e-9;
  return Math.abs(x - target) <= tolerance * Math.abs(target);
}

/** How a statement number relates to the evidence values; recomputable from other values. */
export interface Derivation {
  label: string;
  compute(values: readonly number[]): number;
}

function derivations(kind: NumberKind, n: number): Derivation[] {
  const list: Derivation[] = [];
  for (let i = 0; i < n; i++) {
    if (kind !== "percent") list.push({ label: `value[${i}]`, compute: (v) => v[i]! });
    if (kind !== "money") list.push({ label: `value[${i}] as %`, compute: (v) => v[i]! * 100 });
    if (kind === "percent") list.push({ label: `value[${i}]`, compute: (v) => v[i]! });
  }
  if (kind === "money") return list;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const ratio = (v: readonly number[]) => v[i]! / v[j]!;
      if (kind === "decimal") list.push({ label: `value[${i}]/value[${j}]`, compute: ratio });
      if (kind === "percent") {
        list.push({ label: `value[${i}]/value[${j}] as %`, compute: (v) => ratio(v) * 100 });
        list.push({ label: `(value[${i}]/value[${j}] - 1) as %`, compute: (v) => (ratio(v) - 1) * 100 });
      }
    }
  }
  return list;
}

/** The first derivation from the evidence values that explains this number, or null. */
export function explain(num: StatementNumber, values: readonly number[]): Derivation | null {
  return derivations(num.kind, values.length).find((d) => close(num.value, d.compute(values))) ?? null;
}

/** Money gets "," thousands separators (by regex: ICU locale data differs between Node builds). */
export function formatNumber(value: number, kind: NumberKind, decimals: number): string {
  const fixed = value.toFixed(decimals);
  if (kind !== "money") return fixed;
  const [int, frac] = fixed.split(".");
  return `${int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac ? `.${frac}` : ""}`;
}

/** Readable percentage of a 0-1 rate with 2 decimals: 0.0612 -> "6.12%". */
export const pct = (rate: number): string => `${(rate * 100).toFixed(2)}%`;
