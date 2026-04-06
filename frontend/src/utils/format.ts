/**
 * Humanize a snake_case or camelCase column name.
 * "total_sales" → "Total Sales"
 * "planning_group_category" → "Planning Group Category"
 * "grossMargin" → "Gross Margin"
 */
export function humanizeColumn(col: string): string {
  return col
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Keywords that signal a column holds currency values. */
const CURRENCY_PATTERNS = [
  "sales",
  "revenue",
  "cost",
  "margin",
  "value",
  "price",
  "fees",
  "shipping",
  "cogs",
  "credits",
  "paid",
];

/** Keywords that signal a column holds percentage values. */
const PERCENT_PATTERNS = ["rate", "percent", "pct", "ratio", "cvr", "aur"];

type FormatHint = "currency" | "percent" | "number" | "text";

export function detectFormat(colName: string): FormatHint {
  const lower = colName.toLowerCase();
  if (PERCENT_PATTERNS.some((p) => lower.includes(p))) return "percent";
  if (CURRENCY_PATTERNS.some((p) => lower.includes(p))) return "currency";
  return "number";
}

/**
 * Decide whether to use K/M abbreviation for a column.
 * If all non-zero values are >= 1,000,000 → use M.
 * If all non-zero values are >= 1,000 → use K.
 * Otherwise use plain formatting.
 */
export function detectScale(
  values: number[]
): { suffix: string; divisor: number } {
  const nonZero = values.filter((v) => v !== 0 && !isNaN(v));
  if (nonZero.length === 0) return { suffix: "", divisor: 1 };

  const absValues = nonZero.map(Math.abs);
  const allOverMillion = absValues.every((v) => v >= 1_000_000);
  const allOverThousand = absValues.every((v) => v >= 1_000);

  if (allOverMillion) return { suffix: "M", divisor: 1_000_000 };
  if (allOverThousand) return { suffix: "K", divisor: 1_000 };
  return { suffix: "", divisor: 1 };
}

export type Scale = { suffix: string; divisor: number };

/**
 * Compute per-column scales from a dataset.
 * Returns a map of column name → Scale for numeric columns.
 */
export function computeColumnScales(
  data: Record<string, unknown>[]
): Record<string, Scale> {
  if (data.length === 0) return {};

  const columns = Object.keys(data[0]);
  const scales: Record<string, Scale> = {};

  for (const col of columns) {
    const hint = detectFormat(col);
    if (hint === "percent" || hint === "text") continue;

    const numericValues = data
      .map((row) => row[col])
      .filter((v): v is number => typeof v === "number");
    if (numericValues.length > 0) {
      scales[col] = detectScale(numericValues);
    }
  }

  return scales;
}

export function formatValue(
  value: unknown,
  hint: FormatHint,
  scale?: { suffix: string; divisor: number }
): string {
  if (value === null || value === undefined) return "-";
  if (typeof value !== "number") return String(value);

  if (hint === "percent") {
    // If value is already 0-1 range, multiply by 100
    const pct = Math.abs(value) <= 1 ? value * 100 : value;
    return pct.toFixed(1) + "%";
  }

  const s = scale ?? { suffix: "", divisor: 1 };
  const scaled = value / s.divisor;

  if (hint === "currency") {
    const formatted =
      s.divisor > 1
        ? scaled.toLocaleString(undefined, {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1,
          })
        : scaled.toLocaleString(undefined, {
            minimumFractionDigits: 0,
            maximumFractionDigits: 0,
          });
    return "$" + formatted + s.suffix;
  }

  // Plain number
  const formatted =
    s.divisor > 1
      ? scaled.toLocaleString(undefined, {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        })
      : Number.isInteger(value)
        ? scaled.toLocaleString()
        : scaled.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return formatted + s.suffix;
}
