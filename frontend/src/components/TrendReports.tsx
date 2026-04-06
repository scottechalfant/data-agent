import { useState, useEffect } from "react";
import Markdown from "react-markdown";
import type { TrendReport } from "../types/api";

export function TrendReports() {
  const [reports, setReports] = useState<TrendReport[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/scheduled/reports")
      .then((res) => res.json())
      .then(setReports)
      .catch(console.error);
  }, []);

  if (reports.length === 0) {
    return (
      <div style={{ textAlign: "center", color: "#888", marginTop: 40 }}>
        No trend reports yet. They'll appear here after the first scheduled run.
      </div>
    );
  }

  return (
    <div>
      <h3 style={{ fontWeight: 500, marginBottom: 12 }}>Trend Reports</h3>
      {reports.map((report) => (
        <div
          key={report.id}
          style={{
            border: "1px solid #ddd",
            borderRadius: 8,
            marginBottom: 8,
            overflow: "hidden",
          }}
        >
          <div
            onClick={() => setExpanded(expanded === report.id ? null : report.id)}
            style={{
              padding: "10px 16px",
              background: "#fafafa",
              cursor: "pointer",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span style={{ fontWeight: 500 }}>
              {report.type === "daily_trends" ? "Daily Trends" : "Weekly Deep Dive"}
            </span>
            <span style={{ color: "#888", fontSize: 13 }}>
              {new Date(report.created_at).toLocaleString()}
            </span>
          </div>
          {expanded === report.id && (
            <div style={{ padding: "12px 16px" }}>
              <Markdown>{report.message}</Markdown>
              <div style={{ fontSize: 11, color: "#999", marginTop: 8 }}>
                Tools used: {report.tool_calls_made.join(", ")}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
