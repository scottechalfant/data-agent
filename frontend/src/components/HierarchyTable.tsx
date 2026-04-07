import { useState, useMemo } from "react";
import type { HierarchyTableSpec } from "../types/api";
import {
  humanizeColumn,
  detectFormat,
  detectScale,
  formatValue,
} from "../utils/format";

interface HierarchyTableProps {
  spec: HierarchyTableSpec;
}

interface TreeNode {
  label: string;
  level: number;
  row: Record<string, unknown>;
  children: TreeNode[];
  key: string;
}

/**
 * Build a tree from flat rollup data.
 * Rows where lower hierarchy columns are null are subtotals for the level above.
 * A row where ALL hierarchy columns are null is the grand total.
 */
function buildTree(
  data: Record<string, unknown>[],
  hierarchyKeys: string[]
): TreeNode[] {
  const root: TreeNode[] = [];
  let grandTotal: TreeNode | null = null;

  // Separate rows by depth, then process parents before children
  const rowsByDepth: Map<number, typeof data> = new Map();
  for (const row of data) {
    const depth = hierarchyKeys.findIndex(
      (k) => row[k] === null || row[k] === undefined || row[k] === ""
    );
    const d = depth === -1 ? hierarchyKeys.length : depth;
    if (!rowsByDepth.has(d)) rowsByDepth.set(d, []);
    rowsByDepth.get(d)!.push(row);
  }

  // Process in depth order: 0 (grand total), 1 (top level), 2, ...
  const sortedDepths = [...rowsByDepth.keys()].sort((a, b) => a - b);
  const sortedData = sortedDepths.flatMap((d) => rowsByDepth.get(d)!);

  for (const row of sortedData) {
    const depth = hierarchyKeys.findIndex(
      (k) => row[k] === null || row[k] === undefined || row[k] === ""
    );
    const effectiveDepth = depth === -1 ? hierarchyKeys.length : depth;

    if (effectiveDepth === 0) {
      // Grand total row — keep the first one found (SQL orders it first with correct totals)
      if (!grandTotal) {
        grandTotal = {
          label: "TOTAL",
          level: 0,
          row,
          children: [],
          key: "total",
        };
      }
      continue;
    }

    const label = String(row[hierarchyKeys[effectiveDepth - 1]] ?? "");
    const node: TreeNode = {
      label,
      level: effectiveDepth,
      row,
      children: [],
      key: hierarchyKeys
        .slice(0, effectiveDepth)
        .map((k) => String(row[k] ?? ""))
        .join("→"),
    };

    // Find parent
    if (effectiveDepth === 1) {
      root.push(node);
    } else {
      // Walk up to find parent at level effectiveDepth - 1
      const parentKey = hierarchyKeys
        .slice(0, effectiveDepth - 1)
        .map((k) => String(row[k] ?? ""))
        .join("→");
      const parent = findNode(root, parentKey);
      if (parent) {
        parent.children.push(node);
      } else {
        root.push(node);
      }
    }
  }

  // Put grand total at the top
  if (grandTotal) {
    return [grandTotal, ...root];
  }
  return root;
}

function findNode(nodes: TreeNode[], key: string): TreeNode | null {
  for (const node of nodes) {
    if (node.key === key) return node;
    const found = findNode(node.children, key);
    if (found) return found;
  }
  return null;
}

function flattenTree(
  nodes: TreeNode[],
  expanded: Set<string>
): { node: TreeNode; indent: number }[] {
  const result: { node: TreeNode; indent: number }[] = [];
  for (const node of nodes) {
    result.push({ node, indent: node.level });
    if (node.children.length > 0 && expanded.has(node.key)) {
      result.push(...flattenTree(node.children, expanded));
    }
  }
  return result;
}

export function HierarchyTable({ spec }: HierarchyTableProps) {
  const { hierarchy_keys, value_keys, data } = spec;

  const tree = useMemo(() => buildTree(data, hierarchy_keys), [data, hierarchy_keys]);

  // Start with top level expanded
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const expandAll = () => {
    const all = new Set<string>();
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.children.length > 0) {
          all.add(n.key);
          walk(n.children);
        }
      }
    };
    walk(tree);
    setExpanded(all);
  };

  const collapseAll = () => setExpanded(new Set());

  const flatRows = useMemo(() => flattenTree(tree, expanded), [tree, expanded]);

  // Compute value column formatting
  const valueMeta = value_keys.map((col) => {
    const hint = detectFormat(col);
    const numericValues = data
      .map((row) => row[col])
      .filter((v): v is number => typeof v === "number");
    const scale =
      hint === "currency" || hint === "number"
        ? detectScale(numericValues)
        : undefined;
    return { col, hint, scale };
  });

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
        <button
          onClick={expandAll}
          style={{
            padding: "2px 8px",
            borderRadius: 3,
            border: "1px solid #ccc",
            background: "#fff",
            fontSize: 11,
            color: "#555",
            cursor: "pointer",
          }}
        >
          Expand all
        </button>
        <button
          onClick={collapseAll}
          style={{
            padding: "2px 8px",
            borderRadius: 3,
            border: "1px solid #ccc",
            background: "#fff",
            fontSize: 11,
            color: "#555",
            cursor: "pointer",
          }}
        >
          Collapse all
        </button>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            borderCollapse: "collapse",
            fontSize: 13,
            width: "100%",
          }}
        >
          <thead>
            <tr>
              <th
                style={{
                  borderBottom: "2px solid #ddd",
                  padding: "6px 10px",
                  textAlign: "left",
                  background: "#f5f5f5",
                  minWidth: 200,
                }}
              >
                {hierarchy_keys.map(humanizeColumn).join(" / ")}
              </th>
              {valueMeta.map(({ col, scale }) => (
                <th
                  key={col}
                  style={{
                    borderBottom: "2px solid #ddd",
                    padding: "6px 10px",
                    textAlign: "right",
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
            {flatRows.map(({ node, indent }, rowIdx) => {
              const hasChildren = node.children.length > 0;
              const isExpanded = expanded.has(node.key);
              const isTotal = node.label === "TOTAL";
              const isTopLevel = node.level <= 1;

              return (
                <tr
                  key={`${node.key}-${rowIdx}`}
                  style={{
                    background: isTotal
                      ? "#e8eaf6"
                      : isTopLevel && !isTotal
                        ? "#f5f5f5"
                        : "#fff",
                    fontWeight: isTotal || isTopLevel ? 600 : 400,
                    borderBottom: isTotal ? "2px solid #9fa8da" : undefined,
                  }}
                >
                  <td
                    style={{
                      borderBottom: isTotal
                        ? "2px solid #9fa8da"
                        : "1px solid #eee",
                      padding: "4px 10px",
                      paddingLeft: 10 + indent * 20,
                      whiteSpace: "nowrap",
                      cursor: hasChildren ? "pointer" : "default",
                    }}
                    onClick={() => hasChildren && toggle(node.key)}
                  >
                    {hasChildren && (
                      <span
                        style={{
                          display: "inline-block",
                          width: 16,
                          fontSize: 10,
                          color: "#999",
                          userSelect: "none",
                        }}
                      >
                        {isExpanded ? "▼" : "▶"}
                      </span>
                    )}
                    {!hasChildren && (
                      <span style={{ display: "inline-block", width: 16 }} />
                    )}
                    {node.label}
                  </td>
                  {valueMeta.map(({ col, hint, scale }) => (
                    <td
                      key={col}
                      style={{
                        borderBottom: isTotal
                          ? "2px solid #9fa8da"
                          : "1px solid #eee",
                        padding: "4px 10px",
                        textAlign: "right",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {formatValue(node.row[col], hint, scale)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
