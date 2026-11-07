// Best-practice checks that need no slicing: what the geometry says about bed adhesion, tipping and overhangs,
// read against the chosen process. OrcaSlicer's own warnings come from the slices and are shown beside these.
import type { Advice, BedSpec, Part, PartAnalysis } from '../../types.ts';

type Config = Record<string, string | string[]>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';

export function partAdvice(part: Part, a: PartAnalysis, process: Config, bed: BedSpec, bestFaceArea: number | null): Advice[] {
  const out: Advice[] = [];
  const id = part.id;
  if (a.height > bed.maxHeight) {
    out.push({ level: 'error', partId: id, message: `${a.height.toFixed(1)} mm tall: the printer reaches ${bed.maxHeight} mm.` });
  }
  if (a.contactArea < 1) {
    out.push({ level: 'error', partId: id, message: 'Hardly touches the bed (under 1 mm² flat on it). Lay it flat or check its orientation.' });
  } else if (a.contactArea < 30 && a.height > 15) {
    out.push({ level: 'warning', partId: id, message: `Only ${a.contactArea.toFixed(0)} mm² on the bed for a ${a.height.toFixed(0)} mm tall part: it may come loose. A brim helps.` });
  }
  const brim = one(process.brim_type);
  if (a.slenderness > 4) {
    if (brim === 'no_brim') out.push({ level: 'warning', partId: id, message: `Tall and thin (${a.slenderness.toFixed(1)}:1). Turn on a brim, or it may wobble or tip.` });
    else out.push({ level: 'info', partId: id, message: `Tall and thin (${a.slenderness.toFixed(1)}:1); the process's ${brim.replace(/_/g, ' ')} should hold it.` });
  }
  if (one(process.enable_support) !== '1') {
    const threshold = Math.max(50, a.footprintArea * 0.05);
    if (a.overhangArea > threshold) {
      out.push({
        level: 'warning',
        partId: id,
        message: `About ${a.overhangArea.toFixed(0)} mm² faces down at less than ${one(process.support_threshold_angle) || '30'}° with supports off. OrcaSlicer bridges short spans; longer ones need supports or another orientation.`,
      });
    }
  }
  if (bestFaceArea !== null && bestFaceArea > a.contactArea * 2 && bestFaceArea - a.contactArea > 20) {
    out.push({
      level: 'info',
      partId: id,
      message: `Laid on another face it would have ${bestFaceArea.toFixed(0)} mm² on the bed instead of ${a.contactArea.toFixed(0)} mm². "Lay flat" turns it.`,
    });
  }
  return out;
}
