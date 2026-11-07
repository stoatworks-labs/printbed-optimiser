// The count sweep's arithmetic: which counts to slice, which count to recommend, and how to split an order
// across plates. Pure functions over sliced plates, so they are tested without the engine.
import type { PlateResult } from '../../types.ts';

/** Counts to slice: every count up to `dense`, then about `sparse` more spread geometrically, ending at max. */
export function sampleCounts(max: number, dense = 12, sparse = 14): number[] {
  if (max <= 0) return [];
  if (max <= dense + sparse) return Array.from({ length: max }, (_, i) => i + 1);
  const out = new Set<number>(Array.from({ length: dense }, (_, i) => i + 1));
  const ratio = Math.pow(max / dense, 1 / sparse);
  for (let i = 1; i <= sparse; i++) out.add(Math.min(max, Math.round(dense * Math.pow(ratio, i))));
  out.add(max - 1);
  out.add(max);
  return [...out].sort((a, b) => a - b);
}

/** Seconds a plate takes, the slicer's estimate plus the per-plate overhead it leaves out. */
export function plateSeconds(p: PlateResult, overheadSeconds: number): number | null {
  return p.ok && p.printSeconds !== null ? p.printSeconds + overheadSeconds : null;
}

export interface Recommendation {
  /** Lowest time per kit of all plates that sliced. */
  fastest: PlateResult | null;
  /** The fewest kits within `tolerance` of the fastest, preferring plates the slicer did not warn about. */
  recommended: PlateResult | null;
  /** Why the recommendation is what it is, in a sentence. */
  reason: string;
}

export function recommend(
  plates: PlateResult[],
  opts: { overheadSeconds: number; tolerance: number; maxPlateSeconds?: number | null },
): Recommendation {
  const within = (p: PlateResult) => {
    const s = plateSeconds(p, opts.overheadSeconds);
    return s !== null && (!opts.maxPlateSeconds || s <= opts.maxPlateSeconds);
  };
  const per = (p: PlateResult) => plateSeconds(p, opts.overheadSeconds)! / p.kits;
  const ok = plates.filter(within).sort((a, b) => a.kits - b.kits);
  if (!ok.length) {
    const anyOk = plates.some((p) => p.ok);
    return {
      fastest: null,
      recommended: null,
      reason: anyOk ? 'Every plate that sliced runs longer than the time limit.' : 'No plate sliced.',
    };
  }
  const clean = ok.filter((p) => p.warnings.length === 0);
  const pool = clean.length ? clean : ok;
  const fastest = pool.reduce((a, b) => (per(b) < per(a) - 1e-9 ? b : a));
  const limit = per(fastest) * (1 + opts.tolerance);
  const recommended = pool.find((p) => per(p) <= limit) ?? fastest;
  let reason: string;
  if (recommended === fastest) reason = `${fastest.kits} per plate is the fastest per piece.`;
  else {
    const loss = ((per(recommended) / per(fastest) - 1) * 100).toFixed(1);
    reason = `${recommended.kits} per plate is within ${loss}% of the fastest (${fastest.kits} per plate), with ${fastest.kits - recommended.kits} fewer at risk if the plate fails.`;
  }
  if (!clean.length) reason += ' Every plate drew a slicer warning; read them before printing.';
  else if (clean.length < ok.length) reason += ' Plates with slicer warnings were left out.';
  return { fastest, recommended, reason };
}

/** Plate seconds for any count up to the largest sliced, interpolated between sliced counts. */
export function timeline(plates: PlateResult[], overheadSeconds: number): (kits: number) => { seconds: number; estimated: boolean } | null {
  const pts = plates
    .filter((p) => p.ok && p.printSeconds !== null)
    .map((p) => [p.kits, p.printSeconds! + overheadSeconds] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  return (k) => {
    if (!pts.length || k < pts[0][0] || k > pts[pts.length - 1][0]) return null;
    for (let i = 0; i < pts.length; i++) {
      if (pts[i][0] === k) return { seconds: pts[i][1], estimated: false };
      if (pts[i][0] > k) {
        const [k0, s0] = pts[i - 1];
        const [k1, s1] = pts[i];
        return { seconds: s0 + ((s1 - s0) * (k - k0)) / (k1 - k0), estimated: true };
      }
    }
    return null;
  };
}

export interface QuantityPlan {
  plates: { kits: number; seconds: number; estimated: boolean }[];
  totalSeconds: number;
}

/** The split of `quantity` kits over plates that finishes soonest (plates printed one after another). */
export function planQuantity(
  plates: PlateResult[],
  quantity: number,
  opts: { overheadSeconds: number; maxPlateSeconds?: number | null },
): QuantityPlan | null {
  if (quantity <= 0) return { plates: [], totalSeconds: 0 };
  const t = timeline(plates, opts.overheadSeconds);
  const maxKits = Math.max(0, ...plates.filter((p) => p.ok).map((p) => p.kits));
  const options: { kits: number; seconds: number; estimated: boolean }[] = [];
  for (let k = 1; k <= maxKits; k++) {
    const s = t(k);
    if (s && (!opts.maxPlateSeconds || s.seconds <= opts.maxPlateSeconds)) options.push({ kits: k, ...s });
  }
  if (!options.length) return null;
  const best = new Float64Array(quantity + 1).fill(Infinity);
  const choice = new Int32Array(quantity + 1).fill(-1);
  best[0] = 0;
  for (let q = 1; q <= quantity; q++) {
    for (let i = 0; i < options.length; i++) {
      const o = options[i];
      // A plate may hold more than is still needed: the last plate can be part-filled with the same layout.
      const take = Math.min(o.kits, q);
      if (take !== o.kits && o.kits !== q && options.some((x) => x.kits === take)) continue;
      const cost = best[q - take] + o.seconds + 1e-6 * o.kits; // the tiny term prefers smaller plates on a tie
      if (cost < best[q]) {
        best[q] = cost;
        choice[q] = i;
      }
    }
  }
  if (!Number.isFinite(best[quantity])) return null;
  const out: QuantityPlan['plates'] = [];
  for (let q = quantity; q > 0; ) {
    const o = options[choice[q]];
    const take = Math.min(o.kits, q);
    out.push(take === o.kits ? o : { kits: take, ...(t(take) ?? o) });
    q -= take;
  }
  out.sort((a, b) => b.kits - a.kits);
  return { plates: out, totalSeconds: out.reduce((s, p) => s + p.seconds, 0) };
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.round(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${s}s`;
}
