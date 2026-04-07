import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  ScatterChart,
  Scatter,
  RadarChart,
  Radar,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  FunnelChart,
  Funnel,
  LabelList,
  Treemap,
  ComposedChart,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
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
  "#00695c",
  "#ad1457",
  "#4e342e",
  "#546e7a",
];

interface ChartProps {
  spec: ChartSpec;
  scaleOverrides?: Record<string, Scale>;
}

const TOTAL_LABELS = new Set(["total", "all", "grand total", "sum", "overall"]);

export function Chart({ spec, scaleOverrides }: ChartProps) {
  const { type, title, x_key, y_keys, y_label } = spec;

  // Filter chart data: detect ROLLUP and keep only top-level rows
  const data = (() => {
    const raw = spec.data;
    if (raw.length === 0) return raw;

    const columns = Object.keys(raw[0]);

    // Find all string columns that have at least one null/empty value
    // These are potential hierarchy columns from GROUP BY ROLLUP
    const stringColsWithNulls = columns.filter((col) => {
      const hasNull = raw.some(
        (r) => r[col] === null || r[col] === undefined || r[col] === ""
      );
      const hasString = raw.some((r) => typeof r[col] === "string" && r[col] !== "");
      return hasNull && hasString;
    });

    if (stringColsWithNulls.length === 0) {
      // No ROLLUP detected — just filter TOTALs
      return raw.filter((row) => {
        const xVal = row[x_key];
        if (xVal === null || xVal === undefined || xVal === "") return false;
        if (typeof xVal === "string" && TOTAL_LABELS.has(xVal.toLowerCase().trim())) return false;
        return true;
      });
    }

    // ROLLUP detected. Sort hierarchy cols by null count ascending
    // (fewer nulls = higher level in hierarchy)
    stringColsWithNulls.sort((a, b) => {
      const aNulls = raw.filter((r) => r[a] === null || r[a] === undefined || r[a] === "").length;
      const bNulls = raw.filter((r) => r[b] === null || r[b] === undefined || r[b] === "").length;
      return aNulls - bNulls;
    });

    // The first hierarchy column (fewest nulls) is the top level.
    // Keep rows where the x_key is set but all OTHER hierarchy columns are null.
    // This gives us category-level rows only.
    const otherHierCols = stringColsWithNulls.filter((c) => c !== x_key);

    let filtered: Record<string, unknown>[];
    if (otherHierCols.length > 0) {
      // Keep rows where x_key is non-null and all other hierarchy cols are null
      filtered = raw.filter((row) => {
        const xVal = row[x_key];
        if (xVal === null || xVal === undefined || xVal === "") return false;
        return otherHierCols.every(
          (col) => row[col] === null || row[col] === undefined || row[col] === ""
        );
      });
    } else {
      // x_key is the only hierarchy column — keep rows where it's non-null
      filtered = raw.filter((row) => {
        const xVal = row[x_key];
        return xVal !== null && xVal !== undefined && xVal !== "";
      });
    }

    // Remove TOTAL labels
    return filtered.filter((row) => {
      const xVal = row[x_key];
      if (typeof xVal === "string" && TOTAL_LABELS.has(xVal.toLowerCase().trim())) return false;
      return true;
    });
  })();

  // Don't render charts with too few data points
  if (data.length < 2) return null;

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
        dx: -30,
        style: { fontSize: 12, textAnchor: "middle" as const },
      }
    : undefined;

  const chartMargin = { top: 5, right: 20, bottom: 50, left: 55 };

  const xAxisProps = {
    dataKey: x_key,
    tick: { fontSize: 11 } as const,
    angle: -35,
    textAnchor: "end" as const,
    height: 60,
  };

  const yAxisProps = {
    label: yAxisLabel,
    tick: { fontSize: 11 } as const,
    tickFormatter: formatTick,
    width: 70,
  };

  const renderChart = () => {
    switch (type) {
      // ---- LINE ----
      case "line":
        return (
          <LineChart data={data} margin={chartMargin}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis {...xAxisProps} />
            <YAxis {...yAxisProps} />
            <Tooltip formatter={formatTooltipValue} />
            <Legend verticalAlign="top" height={30} formatter={legendFormatter} />
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
        );

      // ---- AREA ----
      case "area":
        return (
          <AreaChart data={data} margin={chartMargin}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis {...xAxisProps} />
            <YAxis {...yAxisProps} />
            <Tooltip formatter={formatTooltipValue} />
            <Legend verticalAlign="top" height={30} formatter={legendFormatter} />
            {y_keys.map((key, i) => (
              <Area
                key={key}
                type="monotone"
                dataKey={key}
                name={key}
                stroke={COLORS[i % COLORS.length]}
                fill={COLORS[i % COLORS.length]}
                fillOpacity={0.3}
              />
            ))}
          </AreaChart>
        );

      // ---- STACKED AREA ----
      case "stacked_area":
        return (
          <AreaChart data={data} margin={chartMargin}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis {...xAxisProps} />
            <YAxis {...yAxisProps} />
            <Tooltip formatter={formatTooltipValue} />
            <Legend verticalAlign="top" height={30} formatter={legendFormatter} />
            {y_keys.map((key, i) => (
              <Area
                key={key}
                type="monotone"
                dataKey={key}
                name={key}
                stackId="1"
                stroke={COLORS[i % COLORS.length]}
                fill={COLORS[i % COLORS.length]}
                fillOpacity={0.7}
              />
            ))}
          </AreaChart>
        );

      // ---- BAR ----
      case "bar":
        return (
          <BarChart data={data} margin={chartMargin}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis {...xAxisProps} />
            <YAxis {...yAxisProps} />
            <Tooltip formatter={formatTooltipValue} />
            <Legend verticalAlign="top" height={30} formatter={legendFormatter} />
            {y_keys.map((key, i) => (
              <Bar key={key} dataKey={key} name={key} fill={COLORS[i % COLORS.length]} />
            ))}
          </BarChart>
        );

      // ---- STACKED BAR ----
      case "stacked_bar":
        return (
          <BarChart data={data} margin={chartMargin}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis {...xAxisProps} />
            <YAxis {...yAxisProps} />
            <Tooltip formatter={formatTooltipValue} />
            <Legend verticalAlign="top" height={30} formatter={legendFormatter} />
            {y_keys.map((key, i) => (
              <Bar
                key={key}
                dataKey={key}
                name={key}
                stackId="stack"
                fill={COLORS[i % COLORS.length]}
              />
            ))}
          </BarChart>
        );

      // ---- HORIZONTAL BAR ----
      case "horizontal_bar": {
        // Compute label width dynamically based on longest label
        const labels = data.map((row) => String(row[x_key] ?? ""));
        const maxLabelLen = Math.max(...labels.map((l) => l.length));
        // ~5.5px per char at fontSize 10, with min 80 and max 250
        const labelWidth = Math.min(250, Math.max(80, maxLabelLen * 5.5 + 16));
        const labelFontSize = maxLabelLen > 30 ? 9 : maxLabelLen > 20 ? 10 : 11;
        // Taller chart when many rows
        const hBarHeight = Math.max(350, data.length * 28 + 60);

        return (
          <ResponsiveContainer width="100%" height={hBarHeight}>
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 5, right: 20, bottom: 20, left: labelWidth + 10 }}
          >
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis type="number" tickFormatter={formatTick} tick={{ fontSize: 11 }} />
            <YAxis
              type="category"
              dataKey={x_key}
              tick={{ fontSize: labelFontSize }}
              width={labelWidth}
              interval={0}
            />
            <Tooltip formatter={formatTooltipValue} />
            <Legend verticalAlign="top" height={30} formatter={legendFormatter} />
            {y_keys.map((key, i) => (
              <Bar key={key} dataKey={key} name={key} fill={COLORS[i % COLORS.length]} />
            ))}
          </BarChart>
          </ResponsiveContainer>
        );
      }

      // ---- COMBO (bars + lines) ----
      case "combo":
        return (
          <ComposedChart data={data} margin={{ ...chartMargin, right: 55 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis {...xAxisProps} />
            <YAxis yAxisId="left" {...yAxisProps} />
            {y_keys.length > 1 && (() => {
              const rightHint = detectFormat(y_keys[1]);
              const rightScale = detectScale(
                data.map((r) => r[y_keys[1]]).filter((v): v is number => typeof v === "number")
              );
              return (
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v: number) => formatValue(v, rightHint, rightScale)}
                  width={70}
                  label={{
                    value: humanizeColumn(y_keys[1]) + (rightScale.suffix ? ` (${rightScale.suffix})` : ""),
                    angle: 90,
                    position: "outside" as const,
                    dx: 30,
                    style: { fontSize: 12, textAnchor: "middle" as const },
                  }}
                />
              );
            })()}
            <Tooltip formatter={formatTooltipValue} />
            <Legend verticalAlign="top" height={30} formatter={legendFormatter} />
            {/* First y_key as bars */}
            <Bar
              yAxisId="left"
              dataKey={y_keys[0]}
              name={y_keys[0]}
              fill={COLORS[0]}
            />
            {/* Remaining y_keys as lines on right axis */}
            {y_keys.slice(1).map((key, i) => (
              <Line
                key={key}
                yAxisId="right"
                type="monotone"
                dataKey={key}
                name={key}
                stroke={COLORS[(i + 1) % COLORS.length]}
                strokeWidth={2}
                dot={{ r: 3 }}
              />
            ))}
          </ComposedChart>
        );

      // ---- PIE ----
      case "pie":
        return (
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
            <Tooltip formatter={(value: number) => formatValue(value, yHint, yScale)} />
            <Legend />
          </PieChart>
        );

      // ---- SCATTER ----
      case "scatter":
        return (
          <ScatterChart margin={chartMargin}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey={x_key}
              type="number"
              name={humanizeColumn(x_key)}
              tick={{ fontSize: 11 }}
              tickFormatter={(v: number) =>
                formatValue(v, detectFormat(x_key), detectScale(
                  data.map((r) => r[x_key]).filter((v): v is number => typeof v === "number")
                ))
              }
            />
            <YAxis
              dataKey={y_keys[0]}
              type="number"
              name={humanizeColumn(y_keys[0])}
              {...yAxisProps}
            />
            {y_keys.length > 1 && (
              <ZAxis
                dataKey={y_keys[1]}
                type="number"
                range={[50, 400]}
                name={humanizeColumn(y_keys[1])}
              />
            )}
            <Tooltip
              formatter={(value: number, name: string) => [
                formatValue(value, detectFormat(name), yScale),
                humanizeColumn(name),
              ]}
            />
            <Scatter data={data} fill={COLORS[0]} />
          </ScatterChart>
        );

      // ---- HEATMAP (rendered as a grid of colored cells) ----
      case "heatmap": {
        // data should have x_key (column), y_keys[0] (row category), y_keys[1] (value)
        const valueKey = y_keys.length > 1 ? y_keys[1] : y_keys[0];
        const rowKey = y_keys.length > 1 ? y_keys[0] : x_key;
        const values = data
          .map((r) => r[valueKey])
          .filter((v): v is number => typeof v === "number");
        const minVal = Math.min(...values);
        const maxVal = Math.max(...values);

        // Group data by row
        const rows = [...new Set(data.map((r) => String(r[rowKey])))];
        const cols = [...new Set(data.map((r) => String(r[x_key])))];

        const cellSize = Math.max(30, Math.min(60, 600 / Math.max(cols.length, 1)));
        const height = rows.length * cellSize + 80;

        return (
          <div style={{ overflowX: "auto" }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: `120px repeat(${cols.length}, ${cellSize}px)`,
                gap: 1,
                fontSize: 11,
              }}
            >
              {/* Header row */}
              <div />
              {cols.map((col) => (
                <div
                  key={col}
                  style={{
                    textAlign: "center",
                    padding: 4,
                    fontWeight: 600,
                    transform: "rotate(-35deg)",
                    transformOrigin: "bottom left",
                    height: 50,
                    display: "flex",
                    alignItems: "flex-end",
                  }}
                >
                  {col}
                </div>
              ))}
              {/* Data rows */}
              {rows.map((row) => (
                <>
                  <div
                    key={`label-${row}`}
                    style={{
                      padding: "4px 8px",
                      fontWeight: 500,
                      display: "flex",
                      alignItems: "center",
                    }}
                  >
                    {row}
                  </div>
                  {cols.map((col) => {
                    const point = data.find(
                      (r) => String(r[rowKey]) === row && String(r[x_key]) === col
                    );
                    const val = point ? (point[valueKey] as number) : 0;
                    const intensity =
                      maxVal === minVal ? 0.5 : (val - minVal) / (maxVal - minVal);
                    return (
                      <div
                        key={`${row}-${col}`}
                        title={`${row} × ${col}: ${formatValue(val, yHint, yScale)}`}
                        style={{
                          background: `rgba(25, 118, 210, ${0.1 + intensity * 0.8})`,
                          color: intensity > 0.5 ? "#fff" : "#333",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          padding: 2,
                          fontSize: 10,
                          minHeight: cellSize - 2,
                        }}
                      >
                        {formatValue(val, yHint, yScale)}
                      </div>
                    );
                  })}
                </>
              ))}
            </div>
          </div>
        );
      }

      // ---- WATERFALL ----
      case "waterfall": {
        const valueKey = y_keys[0];
        let cumulative = 0;
        const waterfallData = data.map((row, i) => {
          const val = (row[valueKey] as number) || 0;
          const start = cumulative;
          cumulative += val;
          return {
            ...row,
            _start: start,
            _end: cumulative,
            _value: val,
            _isLast: i === data.length - 1,
          };
        });

        return (
          <BarChart data={waterfallData} margin={chartMargin}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis {...xAxisProps} />
            <YAxis {...yAxisProps} />
            <Tooltip
              formatter={(value: number) => formatValue(value, yHint, yScale)}
            />
            <ReferenceLine y={0} stroke="#666" />
            {/* Invisible bar for the base */}
            <Bar dataKey="_start" stackId="waterfall" fill="transparent" />
            {/* Visible bar for the value */}
            <Bar dataKey="_value" stackId="waterfall" name={humanizeColumn(valueKey)}>
              {waterfallData.map((entry, i) => (
                <Cell
                  key={i}
                  fill={
                    entry._isLast
                      ? COLORS[2]
                      : entry._value >= 0
                        ? COLORS[0]
                        : COLORS[1]
                  }
                />
              ))}
            </Bar>
          </BarChart>
        );
      }

      // ---- FUNNEL ----
      case "funnel":
        return (
          <FunnelChart>
            <Tooltip formatter={(value: number) => formatValue(value, yHint, yScale)} />
            <Funnel dataKey={y_keys[0]} data={data} nameKey={x_key}>
              {data.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
              <LabelList
                dataKey={x_key}
                position="right"
                style={{ fontSize: 12, fill: "#333" }}
              />
            </Funnel>
          </FunnelChart>
        );

      // ---- TREEMAP ----
      case "treemap": {
        const treemapData = data.map((row, i) => ({
          name: String(row[x_key]),
          size: (row[y_keys[0]] as number) || 0,
          fill: COLORS[i % COLORS.length],
        }));

        return (
          <Treemap
            data={treemapData}
            dataKey="size"
            nameKey="name"
            aspectRatio={4 / 3}
            stroke="#fff"
            content={({ x, y, width, height, name, value }: any) => {
              if (width < 40 || height < 25) return null;
              return (
                <g>
                  <rect x={x} y={y} width={width} height={height} fill="none" />
                  <text
                    x={x + width / 2}
                    y={y + height / 2 - 6}
                    textAnchor="middle"
                    fill="#fff"
                    fontSize={11}
                    fontWeight={600}
                  >
                    {String(name).slice(0, Math.floor(width / 7))}
                  </text>
                  <text
                    x={x + width / 2}
                    y={y + height / 2 + 10}
                    textAnchor="middle"
                    fill="#fff"
                    fontSize={10}
                  >
                    {formatValue(value, yHint, yScale)}
                  </text>
                </g>
              );
            }}
          >
            {treemapData.map((entry, i) => (
              <Cell key={i} fill={entry.fill} />
            ))}
            <Tooltip
              formatter={(value: number) => formatValue(value, yHint, yScale)}
            />
          </Treemap>
        );
      }

      // ---- RADAR ----
      case "radar":
        return (
          <RadarChart cx="50%" cy="50%" outerRadius="70%" data={data}>
            <PolarGrid />
            <PolarAngleAxis dataKey={x_key} tick={{ fontSize: 11 }} />
            <PolarRadiusAxis tick={{ fontSize: 10 }} tickFormatter={formatTick} />
            {y_keys.map((key, i) => (
              <Radar
                key={key}
                name={humanizeColumn(key)}
                dataKey={key}
                stroke={COLORS[i % COLORS.length]}
                fill={COLORS[i % COLORS.length]}
                fillOpacity={0.2}
              />
            ))}
            <Legend verticalAlign="top" height={30} />
            <Tooltip formatter={formatTooltipValue} />
          </RadarChart>
        );

      default:
        return (
          <div style={{ padding: 20, color: "#888", textAlign: "center" }}>
            Unsupported chart type: {type}
          </div>
        );
    }
  };

  // These types handle their own container/sizing
  if (type === "heatmap" || type === "horizontal_bar") {
    return (
      <div style={{ margin: "12px 0" }}>
        <h4 style={{ margin: "0 0 8px", fontWeight: 500, fontSize: 14 }}>{title}</h4>
        {renderChart()}
      </div>
    );
  }

  return (
    <div style={{ margin: "12px 0" }}>
      <h4 style={{ margin: "0 0 8px", fontWeight: 500, fontSize: 14 }}>{title}</h4>
      <ResponsiveContainer width="100%" height={350}>
        {renderChart()}
      </ResponsiveContainer>
    </div>
  );
}
