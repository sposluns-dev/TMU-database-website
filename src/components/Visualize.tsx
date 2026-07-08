// Visualization panel — extracted from v1's Observable Plot work.
// Renders charts from the current search result set: a Canada choropleth map
// (by province), a bar chart by court, and a bar chart by year.
//
// Observable Plot returns a DOM node, so we mount it into a ref'd div and
// re-render whenever the data or chart type changes.

import { useEffect, useRef, useState } from "react";
import * as Plot from "@observablehq/plot";
import * as topojson from "topojson-client";
import type { SearchResult } from "../lib/types";
import { byCourt, byYear, byCity, provinceCounts } from "../lib/viz";

type ChartType = "map" | "city" | "court" | "year";

const TOPO_URL = `${import.meta.env.BASE_URL}data/canadaprovtopo.json`;

// Cache the parsed topology across renders/instances.
let topoCache: any = null;
async function loadTopo() {
  if (!topoCache) {
    topoCache = await fetch(TOPO_URL).then((r) => r.json());
  }
  return topoCache;
}

export function Visualize({ results }: { results: SearchResult[] }) {
  const [chart, setChart] = useState<ChartType>("map");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    async function render() {
      const el = containerRef.current;
      if (!el) return;
      el.replaceChildren();

      let node: (SVGSVGElement | HTMLElement) | null = null;

      if (chart === "court") {
        const data = byCourt(results);
        node = Plot.plot({
          marginLeft: 90,
          height: Math.max(120, data.length * 26 + 40),
          x: { label: "Cases", grid: true },
          y: { label: null },
          marks: [
            Plot.barX(data, {
              x: "count",
              y: "name",
              fill: "#339999",
              sort: { y: "x", order: "descending" },
            }),
            Plot.text(data, {
              x: "count",
              y: "name",
              text: (d) => d.count,
              dx: 8,
              fill: "#333",
            }),
            Plot.ruleX([0]),
          ],
        });
      } else if (chart === "city") {
        const data = byCity(results);
        node = Plot.plot({
          marginLeft: 130,
          height: Math.max(120, data.length * 22 + 40),
          x: { label: "Cases", grid: true },
          y: { label: null },
          marks: [
            Plot.barX(data, {
              x: "count",
              y: "name",
              fill: "#339999",
              sort: { y: "x", order: "descending" },
            }),
            Plot.text(data, {
              x: "count",
              y: "name",
              text: (d) => d.count,
              dx: 8,
              fill: "#333",
            }),
            Plot.ruleX([0]),
          ],
        });
      } else if (chart === "year") {
        const data = byYear(results);
        node = Plot.plot({
          marginLeft: 40,
          x: { label: "Year", tickRotate: -45 },
          y: { label: "Cases", grid: true },
          marks: [
            Plot.barY(data, { x: "name", y: "count", fill: "#E31837" }),
            Plot.ruleY([0]),
          ],
        });
      } else {
        // Canada choropleth by province
        const topo = await loadTopo();
        if (cancelled) return;
        const provinces = topojson.feature(topo, topo.objects.canadaprov) as any;
        const mesh = topojson.mesh(topo, topo.objects.canadaprov);
        const counts = provinceCounts(results);

        node = Plot.plot({
          projection: { type: "conic-conformal", domain: provinces, rotate: [95, 0] },
          width: 700,
          color: {
            scheme: "blues",
            legend: true,
            label: "Cases",
            unknown: "#e6e6e6", // provinces with no cases: visible neutral grey
          },
          marks: [
            // Base layer: every province always drawn with a clear outline.
            Plot.geo(provinces, { fill: "#e6e6e6", stroke: "#9aa0a6", strokeWidth: 0.7 }),
            // Colored layer: provinces that have matching cases.
            Plot.geo(provinces, {
              fill: (d: any) => counts.get(d.properties.name) ?? null,
              title: (d: any) =>
                `${d.properties.name}: ${counts.get(d.properties.name) ?? 0}`,
              stroke: "#9aa0a6",
              strokeWidth: 0.7,
            }),
            Plot.geo(mesh, { stroke: "#9aa0a6", strokeWidth: 0.5 }),
          ],
        });
      }

      if (node && !cancelled) el.append(node);
    }

    render();
    return () => {
      cancelled = true;
    };
  }, [chart, results]);

  return (
    <div className="visualize">
      <div className="visualize-tabs" style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {(["map", "city", "court", "year"] as ChartType[]).map((c) => (
          <button
            key={c}
            onClick={() => setChart(c)}
            aria-pressed={chart === c}
            style={{
              padding: "4px 12px",
              border: "1px solid #ccc",
              borderRadius: 6,
              background: chart === c ? "#339999" : "#fff",
              color: chart === c ? "#fff" : "#333",
              cursor: "pointer",
              textTransform: "capitalize",
            }}
          >
            {c === "map" ? "Canada map" : `By ${c}`}
          </button>
        ))}
      </div>
      <div ref={containerRef} className="visualize-canvas" />
      {results.length === 0 && (
        <p style={{ color: "#888" }}>No results to visualize yet.</p>
      )}
    </div>
  );
}
