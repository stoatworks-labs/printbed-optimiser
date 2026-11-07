// Printer, process and filament: OrcaSlicer's own system presets, offered the way OrcaSlicer offers them.
import type { Profiles } from '../lib/app/useProfiles.ts';
import { plateTemp, plateType } from '../lib/profiles/plates.ts';
import type { BedSpec } from '../types.ts';

export function PrinterPanel({ profiles, bed, busy }: { profiles: Profiles; bed: BedSpec | null; busy: boolean }) {
  const { lib, selection, choices, plates, configs } = profiles;
  const label = (v: string) => plateType(v)?.label ?? v;
  const filament = selection.filament ?? 'This filament';
  const bedTemp = plates && configs ? plateTemp(configs.filaments[0], plates.choice.value) : 0;
  const vendors = lib?.vendors() ?? [];
  const printers = lib ? lib.printers(selection.vendor) : [];
  const disabled = busy || !lib;
  return (
    <section className="card">
      <h2>
        Printer
        {lib && <span className="aside">OrcaSlicer {lib.info.engine.orca.version} presets</span>}
      </h2>
      <div className="grid2">
        <label className="field">
          <span>Maker</span>
          <select value={selection.vendor} disabled={disabled} onChange={(e) => profiles.setVendor(e.target.value)}>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Printer</span>
          <select value={selection.printer} disabled={disabled} onChange={(e) => profiles.setPrinter(e.target.value)}>
            {printers.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Process</span>
        <select value={selection.process ?? ''} disabled={disabled || !choices} onChange={(e) => profiles.setProcess(e.target.value)}>
          {(choices?.processes ?? []).map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Filament</span>
        <select value={selection.filament ?? ''} disabled={disabled || !choices} onChange={(e) => profiles.setFilament(e.target.value)}>
          {(choices?.filaments ?? []).map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Build plate</span>
        <select
          value={plates?.choice.value ?? ''}
          disabled={disabled || !plates || !plates.selectable}
          onChange={(e) => profiles.setPlate(e.target.value)}
        >
          {(plates?.options ?? []).map((p) => (
            <option key={p.value} value={p.value} disabled={!p.ok}>
              {p.label}
              {p.ok ? '' : ' (not for this filament)'}
            </option>
          ))}
        </select>
      </label>
      {plates && (
        <p className="hint" style={{ margin: 0 }}>
          {plates.choice.replaced
            ? `${filament} can't print on the ${label(plates.choice.replaced)}, so this uses the ${label(plates.choice.value)}. `
            : ''}
          {plates.choice.unsupported
            ? `${filament} has no bed temperature for the ${label(plates.choice.value)}, so OrcaSlicer will refuse to slice it. Pick another filament. `
            : bedTemp > 0
              ? `Plate at ${bedTemp} °C. `
              : ''}
          {!plates.selectable && 'OrcaSlicer uses one plate type for this printer.'}
        </p>
      )}
      {bed && (
        <p className="hint" style={{ margin: 0 }}>
          Bed {Math.round(bed.max[0] - bed.min[0])} × {Math.round(bed.max[1] - bed.min[1])} mm, up to {bed.maxHeight} mm tall
          {bed.exclusions.length > 0 && ', with no-go zones'}
          {bed.regions.length > 1 && ', parts kept where every nozzle reaches'}.
        </p>
      )}
      {profiles.error && <p className="banner small">{profiles.error}</p>}
    </section>
  );
}
