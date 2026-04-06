import {
  humanizeColumn,
  detectFormat,
  detectScale,
  formatValue,
  type Scale,
} from "../utils/format";

interface DataTableProps {
  data: Record<string, unknown>[];
  scaleOverrides?: Record<string, Scale>;
}

export function DataTable({ data, scaleOverrides }: DataTableProps) {
  if (data.length === 0) return null;

  const columns = Object.keys(data[0]);

  // Pre-compute format hint and scale per column, using overrides if provided
  const columnMeta = columns.map((col) => {
    const hint = detectFormat(col);
    const scale =
      scaleOverrides && col in scaleOverrides
        ? scaleOverrides[col]
        : hint === "currency" || hint === "number"
          ? detectScale(
              data
                .map((row) => row[col])
                .filter((v): v is number => typeof v === "number")
            )
          : undefined;
    return { col, hint, scale };
  });

  return (
    <div style={{ overflowX: "auto", marginTop: 8 }}>
      <table
        style={{
          borderCollapse: "collapse",
          fontSize: 13,
          width: "100%",
        }}
      >
        <thead>
          <tr>
            {columnMeta.map(({ col, scale }) => (
              <th
                key={col}
                style={{
                  borderBottom: "2px solid #ddd",
                  padding: "6px 10px",
                  textAlign: "left",
                  whiteSpace: "nowrap",
                  background: "#f5f5f5",
                }}
              >
                {humanizeColumn(col)}
                {scale && scale.suffix ? ` (${scale.suffix})` : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.slice(0, 100).map((row, i) => (
            <tr
              key={i}
              style={{ background: i % 2 === 0 ? "#fff" : "#fafafa" }}
            >
              {columnMeta.map(({ col, hint, scale }) => (
                <td
                  key={col}
                  style={{
                    borderBottom: "1px solid #eee",
                    padding: "4px 10px",
                    whiteSpace: "nowrap",
                    textAlign: typeof row[col] === "number" ? "right" : "left",
                  }}
                >
                  {formatValue(row[col], hint, scale)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {data.length > 100 && (
        <p style={{ color: "#888", fontSize: 12, marginTop: 4 }}>
          Showing first 100 of {data.length} rows
        </p>
      )}
    </div>
  );
}
