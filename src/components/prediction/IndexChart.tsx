import { useEffect, useRef, useState } from "react";
import { hms } from "../../lib/format";
import { indexUsd, type IndexPoint } from "./useSettlementIndex";

// Same blue the quote chart validated against the charcoal card; the price to beat is a neutral
// dashed rule so the one data series stays the only coloured mark.
const LINE = "#3987e5";
const H = 220;
const PAD = { top: 14, right: 12, bottom: 24, left: 68 };
const usd = indexUsd;
const clock = (t: number) => hms(new Date(t).toISOString());

/**
 * The settlement index over the event window. Draws only the points it is given, in USD, with the
 * price to beat as a reference rule. The x axis spans the event window when Gemini states one.
 */
export function IndexChart({
  points,
  priceToBeat,
  start,
  expiry,
  label,
}: {
  points: IndexPoint[];
  priceToBeat: number | null;
  start: number | null;
  expiry: number | null;
  label: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return null;

  const t0 = Math.min(start ?? first.t, first.t);
  const t1 = Math.max(expiry ?? last.t, last.t);
  const span = Math.max(t1 - t0, 1);
  const values = points.map((p) => p.value).concat(priceToBeat ?? []);
  const low = Math.min(...values);
  const high = Math.max(...values);
  // Pad the range so a flat series or a line on the price to beat is not drawn on the frame.
  const pad = Math.max((high - low) * 0.15, high * 0.00005);
  const y0 = low - pad;
  const y1 = high + pad;
  const plotW = Math.max(width - PAD.left - PAD.right, 40);
  const plotH = H - PAD.top - PAD.bottom;
  const x = (t: number) => PAD.left + ((t - t0) / span) * plotW;
  const y = (v: number) => PAD.top + (1 - (v - y0) / (y1 - y0)) * plotH;
  const path = points
    .map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.value).toFixed(1)}`)
    .join("");
  const active = hover === null ? null : (points[Math.min(hover, points.length - 1)] ?? null);
  const nearest = (clientX: number, target: SVGSVGElement) => {
    const px = clientX - target.getBoundingClientRect().left;
    let best = 0;
    points.forEach((p, i) => {
      if (Math.abs(x(p.t) - px) < Math.abs(x(points[best]!.t) - px)) best = i;
    });
    setHover(best);
  };

  return (
    <div ref={box} className="relative min-w-0">
      <svg
        width={width}
        height={H}
        role="img"
        tabIndex={0}
        aria-label={`${label} in USD, ${points.length} points. Latest ${usd(last.value)} at ${clock(last.t)}.${priceToBeat === null ? "" : ` Price to beat ${usd(priceToBeat)}.`}`}
        className="block max-w-full touch-pan-y outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onPointerMove={(e) => nearest(e.clientX, e.currentTarget)}
        onPointerDown={(e) => nearest(e.clientX, e.currentTarget)}
        onPointerLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          const from = hover ?? points.length - 1;
          setHover(
            Math.min(points.length - 1, Math.max(0, from + (e.key === "ArrowLeft" ? -1 : 1))),
          );
        }}
      >
        {[y1 - pad, (y0 + y1) / 2, y0 + pad].map((v) => (
          <g key={v}>
            <line
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={y(v)}
              y2={y(v)}
              stroke="var(--border)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={y(v) + 3.5}
              textAnchor="end"
              fontSize={10}
              fill="var(--muted-foreground)"
            >
              {usd(v)}
            </text>
          </g>
        ))}
        <text x={PAD.left} y={H - 6} fontSize={10} fill="var(--muted-foreground)">
          {clock(t0)}
        </text>
        <text
          x={PAD.left + plotW}
          y={H - 6}
          textAnchor="end"
          fontSize={10}
          fill="var(--muted-foreground)"
        >
          {clock(t1)}
        </text>
        {priceToBeat !== null && (
          <g>
            <line
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={y(priceToBeat)}
              y2={y(priceToBeat)}
              stroke="var(--foreground)"
              strokeWidth={1}
              strokeDasharray="4 4"
            />
            <text
              x={PAD.left + plotW}
              y={y(priceToBeat) - 5}
              textAnchor="end"
              fontSize={10}
              fill="var(--foreground)"
            >
              Price to beat {usd(priceToBeat)}
            </text>
          </g>
        )}
        <path
          d={path}
          fill="none"
          stroke={LINE}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {points.length <= 12 &&
          points.map((p) => <circle key={p.t} cx={x(p.t)} cy={y(p.value)} r={2.5} fill={LINE} />)}
        <circle
          cx={x(last.t)}
          cy={y(last.value)}
          r={4}
          fill={LINE}
          stroke="var(--card)"
          strokeWidth={2}
        />
        {active && (
          <g pointerEvents="none">
            <line
              x1={x(active.t)}
              x2={x(active.t)}
              y1={PAD.top}
              y2={PAD.top + plotH}
              stroke="var(--border-strong)"
              strokeWidth={1}
            />
            <circle
              cx={x(active.t)}
              cy={y(active.value)}
              r={4}
              fill={LINE}
              stroke="var(--card)"
              strokeWidth={2}
            />
          </g>
        )}
      </svg>
      {active && (
        <div
          role="status"
          className="pointer-events-none absolute top-8 z-10 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs shadow"
          style={
            x(active.t) > width / 2
              ? { right: width - x(active.t) + 10 }
              : { left: x(active.t) + 10 }
          }
        >
          <p className="tnum text-muted-foreground">{clock(active.t)}</p>
          <p className="tnum">{usd(active.value)}</p>
        </div>
      )}
      <details className="mt-1 text-xs text-muted-foreground">
        <summary className="cursor-pointer">Index values as a table ({points.length})</summary>
        <div className="mt-1 max-h-40 overflow-auto">
          <table className="tnum w-full text-left">
            <thead>
              <tr>
                <th className="font-medium">Time</th>
                <th className="font-medium">Index (USD)</th>
              </tr>
            </thead>
            <tbody>
              {[...points].reverse().map((p) => (
                <tr key={p.t}>
                  <td>{clock(p.t)}</td>
                  <td>{usd(p.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
