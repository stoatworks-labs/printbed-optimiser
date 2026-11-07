// The printer, process and filament the user picked, as OrcaSlicer presets flattened for the engine.
import { useEffect, useMemo, useState } from 'react';
import type { Config } from '@muon3d/slicer-engine-protocol';
import { ProfileLibrary } from '../profiles/profiles.ts';
import { choosePlate, printerPlates, PLATE_TYPES, supportsPlate, type PlateChoice, type PrinterPlates } from '../profiles/plates.ts';

export const SLICER_BASE = new URL('slicer/', document.baseURI);

type Choices = Awaited<ReturnType<ProfileLibrary['choicesFor']>>;

export interface Selection {
  vendor: string;
  printer: string;
  process: string | null;
  filament: string | null;
  /** The build plate the user picked (OrcaSlicer's `curr_bed_type` value); null = the printer's default. */
  plate?: string | null;
}

const KEY = 'printbed-optimiser:selection';
const DEFAULT: Selection = { vendor: 'BBL', printer: 'Bambu Lab X1 Carbon 0.4 nozzle', process: null, filament: null, plate: null };

function saved(): Selection {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Selection | null;
    if (s && typeof s.vendor === 'string' && typeof s.printer === 'string') return s;
  } catch {
    // private window or blocked storage: start from the default
  }
  return DEFAULT;
}

function save(s: Selection) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // not remembered; harmless
  }
}

export interface Profiles {
  lib: ProfileLibrary | null;
  error: string | null;
  selection: Selection;
  choices: Choices | null;
  configs: { machine: Config; process: Config; filaments: Config[] } | null;
  /** The printer's plate rules, and the plate the job is sliced on. */
  plates: (PrinterPlates & { choice: PlateChoice; options: { value: string; label: string; ok: boolean }[] }) | null;
  loading: boolean;
  setVendor: (v: string) => void;
  setPrinter: (p: string) => void;
  setProcess: (p: string) => void;
  setFilament: (f: string) => void;
  setPlate: (p: string) => void;
}

export function useProfiles(): Profiles {
  const [lib, setLib] = useState<ProfileLibrary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(saved);
  const [choices, setChoices] = useState<Choices | null>(null);
  const [flat, setFlat] = useState<{ process: Config; filament: Config } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    ProfileLibrary.open(SLICER_BASE).then(setLib, (e) => setError(`The printer profiles did not load: ${e instanceof Error ? e.message : e}`));
  }, []);

  // The printer's processes and filaments, and the process and filament to start with.
  useEffect(() => {
    if (!lib) return;
    let live = true;
    let { vendor, printer } = selection;
    if (!lib.vendors().some((v) => v.id === vendor)) vendor = DEFAULT.vendor;
    const printers = lib.printers(vendor);
    if (!printers.some((p) => p.name === printer)) printer = printers.find((p) => p.name === DEFAULT.printer)?.name ?? printers[0]?.name ?? '';
    if (vendor !== selection.vendor || printer !== selection.printer) {
      setSelection((s) => ({ ...s, vendor, printer }));
      return;
    }
    setLoading(true);
    setChoices(null);
    setFlat(null);
    lib.choicesFor(vendor, printer).then(
      (c) => {
        if (!live) return;
        setChoices(c);
        setSelection((s) => ({
          ...s,
          process: s.process && c.processes.includes(s.process) ? s.process : c.defaultProcess,
          filament: s.filament && c.filaments.includes(s.filament) ? s.filament : c.defaultFilament,
        }));
      },
      (e) => live && setError(`${printer}: ${e instanceof Error ? e.message : e}`),
    );
    return () => {
      live = false;
    };
  }, [lib, selection.vendor, selection.printer]); // eslint-disable-line react-hooks/exhaustive-deps

  // Flatten the chosen process and filament.
  useEffect(() => {
    if (!lib || !choices || !selection.process || !selection.filament) return;
    let live = true;
    setLoading(true);
    Promise.all([lib.flatten('process', selection.vendor, selection.process), lib.flatten('filament', selection.vendor, selection.filament)]).then(
      ([process, filament]) => {
        if (!live) return;
        setFlat({ process, filament });
        setLoading(false);
      },
      (e) => live && setError(`Presets: ${e instanceof Error ? e.message : e}`),
    );
    return () => {
      live = false;
    };
  }, [lib, choices, selection.vendor, selection.process, selection.filament]);

  useEffect(() => {
    if (flat) save(selection);
  }, [flat, selection]);

  // The plate goes in the job: without `curr_bed_type` OrcaSlicer slices on a Smooth Cool Plate, which many
  // filaments refuse (src/lib/profiles/plates.ts).
  const plates = useMemo<Profiles['plates']>(() => {
    if (!choices) return null;
    const rules = printerPlates(choices.machine, selection.vendor);
    const filament = flat?.filament ?? null;
    return {
      ...rules,
      choice: choosePlate(selection.plate ?? null, rules, filament),
      options: PLATE_TYPES.map((p) => ({ value: p.value, label: p.label, ok: !filament || supportsPlate(filament, p.value) })),
    };
  }, [choices, flat, selection.vendor, selection.plate]);

  const configs = useMemo<Profiles['configs']>(
    () => (choices && flat && plates ? { machine: choices.machine, process: { ...flat.process, curr_bed_type: plates.choice.value }, filaments: [flat.filament] } : null),
    [choices, flat, plates],
  );

  return {
    lib,
    error,
    selection,
    choices,
    configs,
    plates,
    loading,
    setVendor: (vendor) => setSelection((s) => ({ vendor, printer: '', process: null, filament: null, plate: s.plate })),
    setPrinter: (printer) => setSelection((s) => ({ ...s, printer })),
    setProcess: (process) => setSelection((s) => ({ ...s, process })),
    setFilament: (filament) => setSelection((s) => ({ ...s, filament })),
    setPlate: (plate) => setSelection((s) => ({ ...s, plate })),
  };
}
