import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import type { ChartSpec } from "../types/api";
import {
  humanizeColumn,
  detectFormat,
  detectScale,
  formatValue,
  type Scale,
} from "../utils/format";

const COLORS = [
  "#1976d2",
  "#e64a19",
  "#388e3c",
  "#7b1fa2",
  "#f9a825",
  "#00838f",
  "#c62828",
  "#4527a0",
];

interface ChartProps {
  spec: ChartSpec;
  scaleOverrides?: Record<string, Scale>;
}

export function Chart({ spec, scaleOverrides }: ChartProps) {
  const { type, title, x_key, y_keys, data, y_label } = spec;

  // Use override for the primary y key if available, otherwise compute
  const yHint = detectFormat(y_keys[0]);
  const yScale =
    scaleOverrides && y_keys[0] in scaleOverrides
      ? scaleOverrides[y_keys[0]]
      : detectScale(
          data.flatMap((row) =>
            y_keys
              .map((k) => row[k])
              .filter((v): v is number => typeof v === "number")
          )
        );

  const formatTick = (value: number) => formatValue(value, yHint, yScale);

  const formatTooltipValue = (value: number, name: string) => [
    formatValue(value, detectFormat(name), yScale),
    humanizeColumn(name),
  ];

  const legendFormatter = (value: string) => humanizeColumn(value);

  const yAxisLabel = y_label
    ? {
        value: y_label + (yScale.suffix ? ` (${yScale.suffix})` : ""),
        angle: -90,
        position: "outside" as const,
        dx: -15,
        style: { fontSize: 12, textAnchor: "middle" as const },
      }
    : undefined;

  // Shared margin to give room for angled x-axis labels
  const chartMargin = { top: 5, right: 20, bottom: 50, left: 40 };

  return (
    <div style={{ margin: "12px 0" }}>
      <h4 style={{ margin: "0 0 8px", fontWeight: 500, fontSize: 14 }}>
        {title}
      </h4>
      <ResponsiveContainer width="100%" height={350}>
        {type === "line" ? (
          <LineChart data={data} margin={chartMargin}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey={x_key}
              tick={{ fontSize: 11 }}
              angle={-35}
              textAnchor="end"
              height={60}
            />
            <YAxis
              label={yAxisLabel}
              tick={{ fontSize: 11 }}
              tickFormatter={formatTick}
              width={70}
            />
            <Tooltip formatter={formatTooltipValue} />
            <Legend
              verticalAlign="top"
              height={30}
              formatter={legendFormatter}
            />
            {y_keys.map((key, i) => (
              <Line
                key={key}
                type="monotone"
                dataKey={key}
                name={key}
                stroke={COLORS[i % COLORS.length]}
                strokeWidth={2}
                dot={{ r: 3 }}
              />
            ))}
          </LineChart>
        ) : type === "bar" ? (
          <BarChart data={data} margin={chartMargin}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey={x_key}
              tick={{ fontSize: 11 }}
              angle={-35}
              textAnchor="end"
              height={60}
            />
            <YAxis
              label={yAxisLabel}
              tick={{ fontSize: 11 }}
              tickFormatter={formatTick}
              width={70}
            />
            <Tooltip formatter={formatTooltipValue} />
            <Legend
              verticalAlign="top"
              height={30}
              formatter={legendFormatter}
            />
            {y_keys.map((key, i) => (
              <Bar
                key={key}
                dataKey={key}
                name={key}
                fill={COLORS[i % COLORS.length]}
              />
            ))}
          </BarChart>
        ) : (
          <PieChart>
            <Pie
              data={data}
              dataKey={y_keys[0]}
              nameKey={x_key}
              cx="50%"
              cy="50%"
              outerRadius={100}
              label={({ name, percent }: { name: string; percent: number }) =>
                `${name} ${(percent * 100).toFixed(0)}%`
              }
            >
              {data.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              formatter={(value: number) => formatValue(value, yHint, yScale)}
            />
            <Legend />
          </PieChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
