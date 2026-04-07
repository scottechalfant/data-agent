/**
 * Humanize a snake_case or camelCase column name.
 * "total_sales" → "Total Sales"
 * "planning_group_category" → "Planning Group Category"
 * "grossMargin" → "Gross Margin"
 */
const UPPERCASE_WORDS = new Set([
  "yoy", "ly", "id", "uom", "sku", "aur", "cvr", "d2c", "b2b",
  "pos", "sql", "url", "upc", "qty", "gm", "aov",
]);

export function humanizeColumn(col: string): string {
  return col
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(" ")
    .map((word) =>
      UPPERCASE_WORDS.has(word.toLowerCase())
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1)
    )
    .join(" ");
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

/** Keywords that signal a column holds a base percentage (rate, CVR, etc.). */
const PERCENT_PATTERNS = ["rate", "percent", "pct", "ratio", "cvr", "aur"];

/**
 * Keywords that signal a YOY / change / comparison column.
 * These are checked BEFORE the base currency/percent patterns.
 */
const CHANGE_PATTERNS = [
  "yoy", "y_o_y", "year_over_year",
  "wow", "w_o_w", "week_over_week",
  "mom", "m_o_m", "month_over_month",
  "change", "growth", "delta", "diff", "variance",
];

export type FormatHint =
  | "currency"
  | "percent"
  | "percent_change"  // YOY change on a currency or count column → show as %
  | "bps_change"      // YOY change on a percentage column → show as bps
  | "number"
  | "text";

/**
 * Detect the format for a column based on its name.
 *
 * Priority:
 * 1. If name contains a change keyword AND a percent keyword → bps_change
 * 2. If name contains a change keyword (with or without currency/count context) → percent_change
 * 3. If name contains a percent keyword → percent
 * 4. If name contains a currency keyword → currency
 * 5. Else → number
 */
/** Columns that should be treated as text identifiers, not numbers. */
const ID_PATTERNS = [
  "order_id", "item_id", "customer_id", "household_id", "category_id",
  "vendor_id", "forecast_id", "package_id", "shipment_id", "return_id",
  "orderitem_id", "returnitem_id", "location_id", "order_number",
  "tracking_number", "container_number", "zip", "upc",
];

export function detectFormat(colName: string): FormatHint {
  const lower = colName.toLowerCase();

  // ID/identifier columns should display as plain text (no commas, no currency)
  if (ID_PATTERNS.some((p) => lower === p || lower.endsWith("_id"))) return "text";

  const isChange = CHANGE_PATTERNS.some((p) => lower.includes(p));
  const isPercent = PERCENT_PATTERNS.some((p) => lower.includes(p));

  if (isChange && isPercent) return "bps_change";
  if (isChange) return "percent_change";
  if (isPercent) return "percent";
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
 * Detect if a dataset is a pivoted metric table (one row per metric, mixed types in columns).
 * Returns the name of the metric column, or null if not pivoted.
 */
export function detectMetricColumn(
  columns: string[],
  data: Record<string, unknown>[]
): string | null {
  const candidates = columns.filter((col) => {
    const lower = col.toLowerCase();
    return lower === "metric" || lower === "measure" || lower === "kpi";
  });
  if (candidates.length !== 1) return null;

  // Verify: the column should contain string labels, and there should be few rows (< 20)
  const metricCol = candidates[0];
  if (data.length > 20) return null;
  const allStrings = data.every((row) => typeof row[metricCol] === "string");
  if (!allStrings) return null;

  return metricCol;
}

/**
 * For a pivoted metric table, determine the format hint for a cell based on the
 * metric label in that row (not the column name).
 */
export function detectFormatFromMetric(metricValue: string, colName: string): FormatHint {
  const metricLower = metricValue.toLowerCase();
  const colLower = colName.toLowerCase();

  // Is this a YOY/change column?
  const isChangeCol = CHANGE_PATTERNS.some((p) => colLower.includes(p));

  // Detect metric type from the metric label
  const isRateMetric =
    PERCENT_PATTERNS.some((p) => metricLower.includes(p)) ||
    metricLower.includes("margin rate") ||
    metricLower.includes("gm rate") ||
    metricLower.includes("conversion");

  const isCurrencyMetric =
    CURRENCY_PATTERNS.some((p) => metricLower.includes(p)) &&
    !isRateMetric;

  const isCountMetric =
    metricLower.includes("unit") ||
    metricLower.includes("order") ||
    metricLower.includes("count") ||
    metricLower.includes("session");

  if (isChangeCol) {
    return isRateMetric ? "bps_change" : "percent_change";
  }
  if (isRateMetric) return "percent";
  if (isCurrencyMetric) return "currency";
  if (isCountMetric) return "number";

  // Fallback to column-name detection
  return detectFormat(colName);
}

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
    // Only scale currency and plain number columns — not percentages or changes
    if (hint !== "currency" && hint !== "number") continue;

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

  // Percentage (base rate, CVR, etc.)
  if (hint === "percent") {
    // If value is in 0-1 range, multiply by 100
    const pct = Math.abs(value) <= 1 ? value * 100 : value;
    return (pct >= 0 ? "" : "") + pct.toFixed(1) + "%";
  }

  // YOY/change on a currency or count column → format as percentage change
  if (hint === "percent_change") {
    const pct = Math.abs(value) <= 5 ? value * 100 : value;
    const sign = pct > 0 ? "+" : pct < 0 ? "-" : "";
    return sign + Math.abs(pct).toFixed(1) + "%";
  }

  // YOY/change on a percentage column → format as basis points
  // Value is always the raw decimal difference: ty - ly (e.g. 0.6 - 0.5 = 0.1 = 1000 bps)
  if (hint === "bps_change") {
    const bps = value * 10000;
    const sign = bps > 0 ? "+" : bps < 0 ? "-" : "";
    return sign + Math.round(Math.abs(bps)) + " bps";
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
