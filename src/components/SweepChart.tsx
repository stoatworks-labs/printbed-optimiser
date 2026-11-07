// Time per kit against kits per plate, one point per sliced plate. One series, so no legend: the title names it.
// The recommended plate wears the highlight colour and a direct label; plates OrcaSlicer warned about are hollow
// (said in the caption, so it is not colour alone). Hover snaps a crosshair to the nearest sliced count; a click
// shows that plate.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PlateResult } from '../types.ts';
import { formatDuration, plateSeconds } from '../lib/plan/sweep.ts';

interface Props {
  plates: PlateResult[];
  overheadSeconds: number;
  recommended: number | null;
  fastest: number | null;
  selected: number | null;
  noun: string;
  onSelect: (kits: number) => void;
}

const H = 260;
const M = { top: 22, right: 18, bottom: 34, left: 58 };

function niceStep(range: number, target: number): number {
  const raw = range / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

/** A round duration as an axis label: "20m", "2h", "1h 30m". */
function tickLabel(s: number): string {
  if (s === 0) return '0';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (s < 60) return `${s}s`;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Ticks for a duration axis in round minutes or hours. */
function timeTicks(max: number): number[] {
  const steps = [10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
  const step = steps.find((s) => max / s <= 5) ?? 86400 * Math.ceil(max / 86400 / 5);
  const out: number[] = [];
  for (let v = 0; v <= max + 1e-6; v += step) out.push(v);
  return out;
}

export function SweepChart({ plates, overheadSeconds, recommended, fastest, selected, noun, onSelect }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const pts = useMemo(
    () =>
      plates
        .filter((p) => p.ok && p.printSeconds !== null)
        .map((p) => ({ kits: p.kits, per: plateSeconds(p, overheadSeconds)! / p.kits, plate: plateSeconds(p, overheadSeconds)!, warned: p.warnings.length > 0 }))
        .sort((a, b) => a.kits - b.kits),
    [plates, overheadSeconds],
  );
  const failed = plates.filter((p) => !p.ok).map((p) => p.kits);

  if (!pts.length) {
    return (
      <div className="chart" ref={wrap}>
        <div className="empty">{plates.length ? 'No plate sliced.' : 'The chart fills in as plates are sliced.'}</div>
      </div>
    );
  }

  const maxK = Math.max(...pts.map((p) => p.kits), ...failed, 2);
  const maxY = Math.max(...pts.map((p) => p.per)) * 1.08;
  const iw = Math.max(80, width - M.left - M.right);
  const ih = H - M.top - M.bottom;
  const x = (k: number) => M.left + ((k - 1) / Math.max(1, maxK - 1)) * iw;
  const y = (s: number) => M.top + ih - (s / maxY) * ih;
  const xStep = Math.max(1, niceStep(maxK - 1, Math.max(2, Math.floor(iw / 70))));
  const xTicks: number[] = [1];
  for (let k = xStep; k <= maxK; k += xStep) if (k > 1) xTicks.push(k);
  const yTicks = timeTicks(maxY);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.kits).toFixed(1)},${y(p.per).toFixed(1)}`).join('');

  const nearest = (px: number) => {
    let best = pts[0];
    for (const p of pts) if (Math.abs(x(p.kits) - px) < Math.abs(x(best.kits) - px)) best = p;
    return best;
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(nearest(e.clientX - r.left).kits);
  };
  const h = hover !== null ? pts.find((p) => p.kits === hover) : undefined;
  const rec = recommended !== null ? pts.find((p) => p.kits === recommended) : undefined;
  const fast = fastest !== null && fastest !== recommended ? pts.find((p) => p.kits === fastest) : undefined;
  const sel = selected !== null && selected !== recommended ? pts.find((p) => p.kits === selected) : undefined;

  // Keep a direct label inside the plot: anchor it to whichever side has room.
  const labelAt = (px: number) => (px > M.left + iw - 120 ? 'end' : 'start');
  const labelDx = (px: number) => (labelAt(px) === 'end' ? -10 : 10);

  return (
    <div className="chart" ref={wrap}>
      <svg
        height={H}
        viewBox={`0 0 ${width} ${H}`}
        role="img"
        aria-label={`Time per ${noun} for each number of ${noun}s per plate; the table below lists every value.`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        onClick={() => h && onSelect(h.kits)}
        style={{ cursor: 'pointer' }}
      >
        <g className="grid">
          {yTicks.map((t) => (
            <line key={t} x1={M.left} x2={M.left + iw} y1={y(t)} y2={y(t)} />
          ))}
        </g>
        <g className="axis">
          {yTicks.map((t) => (
            <text key={t} x={M.left - 8} y={y(t) + 4} textAnchor="end">
              {tickLabel(t)}
            </text>
          ))}
          {xTicks.map((k) => (
            <text key={k} x={x(k)} y={M.top + ih + 18} textAnchor="middle">
              {k}
            </text>
          ))}
          <text x={M.left + iw / 2} y={H - 2} textAnchor="middle">
            {noun}s per plate
          </text>
        </g>
        {failed.map((k) => (
          <text key={`f${k}`} x={x(k)} y={M.top + ih - 6} textAnchor="middle" fill="var(--critical)" fontSize="12" fontWeight="700">
            ×
          </text>
        ))}
        {sel && <line x1={x(sel.kits)} x2={x(sel.kits)} y1={M.top} y2={M.top + ih} stroke="var(--fg-3)" strokeDasharray="3 3" />}
        {h && <line x1={x(h.kits)} x2={x(h.kits)} y1={M.top} y2={M.top + ih} stroke="var(--fg-2)" strokeWidth="1" />}
        <path d={path} fill="none" stroke="var(--series)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {pts.map((p) => (
          <circle
            key={p.kits}
            cx={x(p.kits)}
            cy={y(p.per)}
            r={p.kits === hover ? 5.5 : 4}
            fill={p.warned ? 'var(--bg-2)' : 'var(--series)'}
            stroke={p.warned ? 'var(--series)' : 'var(--bg-2)'}
            strokeWidth="2"
          />
        ))}
        {fast && (
          <g>
            <circle cx={x(fast.kits)} cy={y(fast.per)} r="7" fill="none" stroke="var(--fg-2)" strokeWidth="1.5" />
            <text className="label sub" x={x(fast.kits) + labelDx(x(fast.kits))} y={y(fast.per) + 18} textAnchor={labelAt(x(fast.kits))}>
              Fastest · {fast.kits}
            </text>
          </g>
        )}
        {rec && (
          <g>
            <circle cx={x(rec.kits)} cy={y(rec.per)} r="6.5" fill="var(--highlight)" stroke="var(--bg-2)" strokeWidth="2" />
            <text className="label" x={x(rec.kits) + labelDx(x(rec.kits))} y={y(rec.per) - 10} textAnchor={labelAt(x(rec.kits))}>
              Recommended · {rec.kits} · {formatDuration(rec.per)} each
            </text>
          </g>
        )}
      </svg>
      {h && (
        <div
          className="tooltip"
          style={{
            left: Math.min(Math.max(0, x(h.kits) + 12), width - 210),
            top: Math.max(0, y(h.per) - 64),
          }}
        >
          <div>
            <b>{h.kits}</b> {noun}
            {h.kits === 1 ? '' : 's'} per plate
          </div>
          <div>
            <b>{formatDuration(h.per)}</b> per {noun} · plate <b>{formatDuration(h.plate)}</b>
          </div>
          {h.warned && <div className="faint">OrcaSlicer warned about this plate</div>}
        </div>
      )}
      <div className="legend">
        <span>
          <i style={{ background: 'var(--series)' }} /> sliced plate
        </span>
        <span>
          <i style={{ background: 'var(--bg-2)', border: '2px solid var(--series)' }} /> sliced with a warning
        </span>
        {failed.length > 0 && (
          <span>
            <b style={{ color: 'var(--critical)' }}>×</b> OrcaSlicer refused it
          </span>
        )}
        {overheadSeconds > 0 && <span className="faint">Times include {formatDuration(overheadSeconds)} per plate for clearing and restarting.</span>}
      </div>
    </div>
  );
}
