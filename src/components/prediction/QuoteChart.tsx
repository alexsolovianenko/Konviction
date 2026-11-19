import { useEffect, useRef, useState } from "react";
import { cents, hms } from "../../lib/format";
import type { QuoteSample } from "./useContractQuotes";

// Validated against the charcoal card surface (CVD and contrast) with the dataviz palette check.
const SERIES = [
  { key: "yes", name: "YES", color: "#3987e5" },
  { key: "no", name: "NO", color: "#d95926" },
] as const;
const H = 220;
const PAD = { top: 12, right: 64, bottom: 24, left: 36 };


/** Line chart of session-observed contract prices. Draws only the samples it is given. */
export function QuoteChart({ samples }: { samples: QuoteSample[] }) {
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
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last) return null;

  const t0 = first.t;
  const span = Math.max(last.t - t0, 1);
  const plotW = Math.max(width - PAD.left - PAD.right, 40);
  const plotH = H - PAD.top - PAD.bottom;
  const x = (t: number) => PAD.left + ((t - t0) / span) * plotW;
  const y = (p: number) => PAD.top + (1 - p) * plotH;
  const path = (key: "yes" | "no") => {
    let d = "";
    let pen = false;
    for (const s of samples) {
      const p = s[key];
      if (p === null) {
        pen = false;
        continue;
      }
      d += `${pen && !s.gap ? "L" : "M"}${x(s.t).toFixed(1)},${y(p).toFixed(1)}`;
      pen = true;
    }
    return d;
  };
  const active = hover === null ? null : (samples[Math.min(hover, samples.length - 1)] ?? null);
  const nearest = (clientX: number, target: SVGSVGElement) => {
    const px = clientX - target.getBoundingClientRect().left;
    let best = 0;
    samples.forEach((s, i) => {
      if (Math.abs(x(s.t) - px) < Math.abs(x(samples[best]!.t) - px)) best = i;
    });
    setHover(best);
  };
  // End labels sit beside the last point; nudge them apart when YES and NO nearly meet.
  const ends = SERIES.flatMap((s) =>
    last[s.key] === null ? [] : [{ ...s, value: last[s.key]!, at: y(last[s.key]!) }],
  );
  if (ends.length === 2 && Math.abs(ends[0]!.at - ends[1]!.at) < 14) {
    const up = ends[0]!.at <= ends[1]!.at ? 0 : 1;
    const mid = (ends[0]!.at + ends[1]!.at) / 2;
    ends[up]!.at = mid - 7;
    ends[1 - up]!.at = mid + 7;
  }

  return (
    <div ref={box} className="relative min-w-0">
      <ul className="mb-1 flex gap-4 text-xs text-muted-foreground" aria-label="Series">
        {SERIES.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-0.5 w-4 rounded"
              style={{ background: s.color }}
            />
            {s.name} buy price
          </li>
        ))}
      </ul>
      <svg
        width={width}
        height={H}
        role="img"
        tabIndex={0}
        aria-label={`Session-observed Gemini Sandbox prices, ${samples.length} samples. Latest YES ${cents(last.yes)}, NO ${cents(last.no)} at ${hms(new Date(last.t).toISOString())}.`}
        className="block max-w-full touch-pan-y outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onPointerMove={(e) => nearest(e.clientX, e.currentTarget)}
        onPointerDown={(e) => nearest(e.clientX, e.currentTarget)}
        onPointerLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          const from = hover ?? samples.length - 1;
          setHover(
            Math.min(samples.length - 1, Math.max(0, from + (e.key === "ArrowLeft" ? -1 : 1))),
          );
        }}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((p) => (
          <g key={p}>
            <line
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={y(p)}
              y2={y(p)}
              stroke="var(--border)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={y(p) + 3.5}
              textAnchor="end"
              fontSize={10}
              fill="var(--muted-foreground)"
            >
              {p * 100}¢
            </text>
          </g>
        ))}
        <text x={PAD.left} y={H - 6} fontSize={10} fill="var(--muted-foreground)">
          {hms(new Date(t0).toISOString())}
        </text>
        {samples.length > 1 && <text
          x={PAD.left + plotW}
          y={H - 6}
          textAnchor="end"
          fontSize={10}
          fill="var(--muted-foreground)"
        >
          {hms(new Date(last.t).toISOString())}
        </text>}
        {SERIES.map((s) => (
          <g key={s.key}>
            <path
              d={path(s.key)}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {samples.length <= 40 &&
              samples.map(
                (p) =>
                  p[s.key] !== null && (
                    <circle key={p.t} cx={x(p.t)} cy={y(p[s.key]!)} r={2.5} fill={s.color} />
                  ),
              )}
          </g>
        ))}
        {ends.map((e) => (
          <g key={e.key}>
            <circle
              cx={x(last.t)}
              cy={y(e.value)}
              r={4}
              fill={e.color}
              stroke="var(--card)"
              strokeWidth={2}
            />
            {x(last.t) + 8 + 52 <= width && (
              <text x={x(last.t) + 8} y={e.at + 3.5} fontSize={11} fill="var(--foreground)">
                {e.name} {cents(e.value)}
              </text>
            )}
          </g>
        ))}
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
            {SERIES.map(
              (s) =>
                active[s.key] !== null && (
                  <circle
                    key={s.key}
                    cx={x(active.t)}
                    cy={y(active[s.key]!)}
                    r={4}
                    fill={s.color}
                    stroke="var(--card)"
                    strokeWidth={2}
                  />
                ),
            )}
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
          <p className="tnum text-muted-foreground">
            Observed {hms(new Date(active.t).toISOString())}
          </p>
          {SERIES.map((s) => (
            <p key={s.key} className="tnum flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block size-2 rounded-full"
                style={{ background: s.color }}
              />
              {s.name} {active[s.key] === null ? "unavailable" : cents(active[s.key])}
            </p>
          ))}
        </div>
      )}
      <details className="mt-1 text-xs text-muted-foreground">
        <summary className="cursor-pointer">Samples as a table ({samples.length})</summary>
        <div className="mt-1 max-h-40 overflow-auto">
          <table className="tnum w-full text-left">
            <thead>
              <tr>
                <th className="font-medium">Observed</th>
                <th className="font-medium">YES buy</th>
                <th className="font-medium">NO buy</th>
              </tr>
            </thead>
            <tbody>
              {[...samples].reverse().map((s) => (
                <tr key={s.t}>
                  <td>{hms(new Date(s.t).toISOString())}</td>
                  <td>{cents(s.yes)}</td>
                  <td>{cents(s.no)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
