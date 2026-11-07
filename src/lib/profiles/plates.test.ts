import { describe, expect, it } from 'vitest';
import { choosePlate, printerPlates, supportsPlate } from './plates.ts';

// Bambu ABS-GF @BBL X1C's plate temperatures in OrcaSlicer 2.5.0-dev's profile set.
const absGf = {
  supertack_plate_temp: ['0'],
  supertack_plate_temp_initial_layer: ['0'],
  cool_plate_temp: ['0'],
  cool_plate_temp_initial_layer: ['0'],
  textured_cool_plate_temp: ['40'],
  textured_cool_plate_temp_initial_layer: ['40'],
  eng_plate_temp: ['90'],
  eng_plate_temp_initial_layer: ['90'],
  hot_plate_temp: ['90'],
  hot_plate_temp_initial_layer: ['90'],
  textured_plate_temp: ['90'],
  textured_plate_temp_initial_layer: ['90'],
};
const pla = { ...absGf, cool_plate_temp: ['35'], cool_plate_temp_initial_layer: ['35'] };

describe('build plates', () => {
  it('lets Bambu Lab printers pick, starting on Textured PEI', () => {
    expect(printerPlates({ default_bed_type: '', support_multi_bed_types: '0' }, 'BBL')).toEqual({ selectable: true, default: 'Textured PEI Plate' });
  });

  it('fixes other printers to Smooth High Temp, as OrcaSlicer does, unless they allow several', () => {
    expect(printerPlates({ support_multi_bed_types: '0' }, 'Prusa')).toEqual({ selectable: false, default: 'High Temp Plate' });
    expect(printerPlates({ support_multi_bed_types: '1' }, 'Qidi').selectable).toBe(true);
  });

  it("uses the printer's own default_bed_type, by value or label", () => {
    expect(printerPlates({ default_bed_type: 'Textured Cool Plate' }, 'BBL').default).toBe('Textured Cool Plate');
    expect(printerPlates({ default_bed_type: 'Smooth Cool Plate' }, 'BBL').default).toBe('Cool Plate');
  });

  it('reads support from both bed temperatures', () => {
    expect(supportsPlate(absGf, 'Cool Plate')).toBe(false);
    expect(supportsPlate(absGf, 'Textured PEI Plate')).toBe(true);
    expect(supportsPlate({ ...absGf, eng_plate_temp_initial_layer: ['0'] }, 'Engineering Plate')).toBe(false);
    expect(supportsPlate(absGf, 'No Such Plate')).toBe(false);
  });

  it("keeps the user's plate when the filament supports it", () => {
    const bbl = printerPlates({}, 'BBL');
    expect(choosePlate('Cool Plate', bbl, pla)).toEqual({ value: 'Cool Plate', replaced: null, unsupported: false });
  });

  it('moves to a plate the filament supports, and says which it replaced', () => {
    const bbl = printerPlates({}, 'BBL');
    expect(choosePlate('Cool Plate', bbl, absGf)).toEqual({ value: 'Textured PEI Plate', replaced: 'Cool Plate', unsupported: false });
    expect(choosePlate('Supertack Plate', { selectable: true, default: 'Textured Cool Plate' }, absGf).value).toBe('Textured Cool Plate');
  });

  it('ignores a picked plate on a printer without a choice, and flags a filament that cannot use its plate', () => {
    const fixed = printerPlates({}, 'Prusa');
    expect(choosePlate('Cool Plate', fixed, pla)).toEqual({ value: 'High Temp Plate', replaced: null, unsupported: false });
    expect(choosePlate(null, fixed, { ...pla, hot_plate_temp: ['0'] })).toEqual({ value: 'High Temp Plate', replaced: null, unsupported: true });
  });

  it('flags a filament with no plate at all', () => {
    const none = Object.fromEntries(Object.keys(absGf).map((k) => [k, ['0']]));
    expect(choosePlate(null, printerPlates({}, 'BBL'), none).unsupported).toBe(true);
  });
});
