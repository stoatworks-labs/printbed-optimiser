// Build plate types, as OrcaSlicer names them (its `curr_bed_type` option), and which ones a filament can print on.
//
// The plate is part of the job: OrcaSlicer takes the bed temperature from the filament's setting for that plate, and
// refuses the plate outright ("Plate 1: Cool Plate does not support filament 1") when that setting is 0. A job with no
// `curr_bed_type` is sliced as a Smooth Cool Plate, which ABS, ASA, PA, PC and most glass- or carbon-filled filaments
// do not support, so the page always sends one.
import type { Config } from '@muon3d/slicer-engine-protocol';

export interface PlateType {
  /** OrcaSlicer's value for `curr_bed_type`. */
  value: string;
  /** OrcaSlicer's label, as its plate menu shows it. */
  label: string;
  /** The filament settings holding this plate's bed temperature (0 = not supported). */
  temp: string;
  tempFirstLayer: string;
}

/** In the order OrcaSlicer's plate menu lists them. */
export const PLATE_TYPES: PlateType[] = [
  { value: 'Supertack Plate', label: 'Cool Plate (SuperTack)', temp: 'supertack_plate_temp', tempFirstLayer: 'supertack_plate_temp_initial_layer' },
  { value: 'Cool Plate', label: 'Smooth Cool Plate', temp: 'cool_plate_temp', tempFirstLayer: 'cool_plate_temp_initial_layer' },
  { value: 'Engineering Plate', label: 'Engineering Plate', temp: 'eng_plate_temp', tempFirstLayer: 'eng_plate_temp_initial_layer' },
  { value: 'High Temp Plate', label: 'Smooth High Temp Plate', temp: 'hot_plate_temp', tempFirstLayer: 'hot_plate_temp_initial_layer' },
  { value: 'Textured PEI Plate', label: 'Textured PEI Plate', temp: 'textured_plate_temp', tempFirstLayer: 'textured_plate_temp_initial_layer' },
  { value: 'Textured Cool Plate', label: 'Textured Cool Plate', temp: 'textured_cool_plate_temp', tempFirstLayer: 'textured_cool_plate_temp_initial_layer' },
];

/** What a plate falls back to, best first, when the filament cannot print on the one chosen. */
const FALLBACK = ['Textured PEI Plate', 'High Temp Plate', 'Engineering Plate', 'Textured Cool Plate', 'Cool Plate', 'Supertack Plate'];

export function plateType(value: string): PlateType | undefined {
  return PLATE_TYPES.find((p) => p.value === value);
}

export interface PrinterPlates {
  /** Whether the user picks the plate. OrcaSlicer offers the choice on Bambu Lab printers and on printers that set
   *  `support_multi_bed_types`; on any other printer it uses one plate, the default, and hides the choice. */
  selectable: boolean;
  /** The plate to start with: the printer's `default_bed_type` if it names one, else OrcaSlicer's own default
   *  (Textured PEI, the plate current Bambu Lab printers ship with, where the user picks; Smooth High Temp, which
   *  OrcaSlicer fixes for printers without a choice). */
  default: string;
}

export function printerPlates(machine: Config, vendor: string): PrinterPlates {
  const selectable = vendor === 'BBL' || text(machine.support_multi_bed_types) === '1';
  const named = text(machine.default_bed_type);
  const own = PLATE_TYPES.find((p) => p.value === named || p.label === named);
  return { selectable, default: own?.value ?? (selectable ? 'Textured PEI Plate' : 'High Temp Plate') };
}

/** Whether the filament can print on the plate: OrcaSlicer's rule, both bed temperatures for it above 0. */
export function supportsPlate(filament: Config, plate: string): boolean {
  const p = plateType(plate);
  if (!p) return false;
  return temp(filament[p.temp]) > 0 && temp(filament[p.tempFirstLayer]) > 0;
}

/** The bed temperature, °C, the filament uses on the plate (0 when it does not support it). */
export function plateTemp(filament: Config, plate: string): number {
  const p = plateType(plate);
  return p ? temp(filament[p.temp]) : 0;
}

export interface PlateChoice {
  /** The plate the job is sliced on. */
  value: string;
  /** Set when that is not the plate the user asked for, because the filament cannot print on it. */
  replaced: string | null;
  /** Set when no plate this printer allows suits the filament (OrcaSlicer will refuse every plate). */
  unsupported: boolean;
}

/** The plate to slice on: the user's (or the printer's) if the filament supports it, else the best that it does. */
export function choosePlate(wanted: string | null, printer: PrinterPlates, filament: Config | null): PlateChoice {
  const asked = printer.selectable && wanted && plateType(wanted) ? wanted : printer.default;
  if (!filament || supportsPlate(filament, asked)) return { value: asked, replaced: null, unsupported: false };
  if (!printer.selectable) return { value: asked, replaced: null, unsupported: true };
  const other = [printer.default, ...FALLBACK].find((p) => supportsPlate(filament, p));
  return other ? { value: other, replaced: asked, unsupported: false } : { value: asked, replaced: null, unsupported: true };
}

function text(v: Config[string] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? '';
}

function temp(v: Config[string] | undefined): number {
  const n = Number(text(v));
  return Number.isFinite(n) ? n : 0;
}
