// OrcaSlicer's printer, process and filament presets, from the profile set served next to the page
// (public/slicer/profiles/, fetched by scripts/fetch-engine.mjs). Presets are flattened by the protocol package's
// flattenPreset, which gives OrcaSlicer's own result; which presets suit a printer follows docs/PROFILES.md §5 of
// the engine.
import {
  flattenPreset,
  type Config,
  type PresetScope,
  type ProfileIndex,
  type VendorBundle,
} from '@muon3d/slicer-engine-protocol';
import { evaluateCondition, machineLookup } from './condition.ts';

export interface SlicerInfo {
  engine: {
    version: string;
    base: string;
    host: string;
    license: string;
    orca: { version: string; commit: string };
    source: string;
    sourceTag: string;
  };
  profiles: { set: string; index: string };
}

export interface PrinterEntry {
  vendor: string;
  name: string;
  model: string;
  variant: string;
  nozzle: string[];
}

export type Fetcher = (url: URL) => Promise<Uint8Array>;

export const browserFetch: Fetcher = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url.pathname}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

async function gunzipIfNeeded(bytes: Uint8Array): Promise<string> {
  // A server that added Content-Encoding: gzip has already decompressed it; the magic bytes tell.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
  }
  return new TextDecoder().decode(bytes);
}

const alias = (name: string) => name.split('@')[0].trim();

export class ProfileLibrary {
  private bundles = new Map<string, Promise<VendorBundle>>();

  private constructor(
    readonly info: SlicerInfo,
    readonly index: ProfileIndex,
    private readonly indexUrl: URL,
    private readonly fetcher: Fetcher,
  ) {}

  /** `base`: the URL of the folder holding slicer.json. */
  static async open(base: URL, fetcher: Fetcher = browserFetch): Promise<ProfileLibrary> {
    const info = JSON.parse(new TextDecoder().decode(await fetcher(new URL('slicer.json', base)))) as SlicerInfo;
    const indexUrl = new URL(info.profiles.index, base);
    const index = JSON.parse(new TextDecoder().decode(await fetcher(indexUrl))) as ProfileIndex;
    return new ProfileLibrary(info, index, indexUrl, fetcher);
  }

  vendors(): { id: string; name: string; printers: number }[] {
    return this.index.vendors
      .filter((v) => v.printers.length > 0)
      .map((v) => ({ id: v.id, name: v.name, printers: v.printers.length }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  printers(vendor: string): PrinterEntry[] {
    const v = this.index.vendors.find((x) => x.id === vendor);
    return (v?.printers ?? []).map((p) => ({ vendor, name: p.name, model: p.model, variant: p.variant, nozzle: p.nozzle }));
  }

  bundle(id: string): Promise<VendorBundle> {
    let b = this.bundles.get(id);
    if (!b) {
      const v = this.index.vendors.find((x) => x.id === id);
      if (!v) return Promise.reject(new Error(`No vendor ${id} in the profile set.`));
      b = this.fetcher(new URL(v.bundle.path, this.indexUrl))
        .then(gunzipIfNeeded)
        .then((text) => JSON.parse(text) as VendorBundle);
      this.bundles.set(id, b);
      b.catch(() => this.bundles.delete(id));
    }
    return b;
  }

  private async sources(vendor: string) {
    const [v, library] = await Promise.all([this.bundle(vendor), this.bundle(this.index.library)]);
    return { vendor: v, library, defaults: this.index.defaults as Record<PresetScope, Config> };
  }

  async flatten(type: PresetScope, vendor: string, name: string): Promise<Config> {
    return flattenPreset(type, name, await this.sources(vendor));
  }

  /** The processes and filaments OrcaSlicer offers with a printer, and its defaults. */
  async choicesFor(vendor: string, printer: string): Promise<{
    machine: Config;
    processes: string[];
    filaments: string[];
    defaultProcess: string | null;
    defaultFilament: string | null;
  }> {
    const src = await this.sources(vendor);
    const machine = flattenPreset('machine', printer, src);
    const lookup = machineLookup(machine, printer);
    const suits = (bundle: VendorBundle, library: VendorBundle | null, type: PresetScope, name: string): boolean => {
      const list = resolved(bundle, library, type, name, 'compatible_printers');
      if (Array.isArray(list) && list.length > 0) return list.includes(printer);
      const cond = resolved(bundle, library, type, name, 'compatible_printers_condition');
      if (typeof cond === 'string' && cond.trim()) {
        try {
          return evaluateCondition(cond, lookup);
        } catch {
          return true; // OrcaSlicer: an expression that fails to evaluate counts as true
        }
      }
      return true;
    };

    const processes = Object.entries(src.vendor.presets.process)
      .filter(([name, p]) => p.instantiation === 'true' && suits(src.vendor, null, 'process', name))
      .map(([name]) => name);

    const own = Object.entries(src.vendor.presets.filament)
      .filter(([name, p]) => p.instantiation === 'true' && suits(src.vendor, src.library, 'filament', name))
      .map(([name]) => name);
    const ownAliases = new Set(own.map(alias));
    const shared =
      src.vendor === src.library
        ? []
        : Object.entries(src.library.presets.filament)
            .filter(([name, p]) => p.instantiation === 'true' && !ownAliases.has(alias(name)) && suits(src.library, src.library, 'filament', name))
            .map(([name]) => name);

    const firstOf = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || null;
    const defaultProcess = firstOf(machine.default_print_profile);
    const defaultFilament = firstOf(machine.default_filament_profile);
    return {
      machine,
      processes,
      filaments: [...own, ...shared],
      defaultProcess: defaultProcess && processes.includes(defaultProcess) ? defaultProcess : (processes[0] ?? null),
      defaultFilament: defaultFilament && (own.includes(defaultFilament) || shared.includes(defaultFilament)) ? defaultFilament : (own[0] ?? shared[0] ?? null),
    };
  }
}

/** A key's value as the preset inherits it: its own, else its nearest parent's. */
function resolved(bundle: VendorBundle, library: VendorBundle | null, type: PresetScope, name: string, key: string): string | string[] | undefined {
  let current: VendorBundle = bundle;
  let n: string | undefined = name;
  for (let depth = 0; n && depth < 32; depth++) {
    let preset: Config | undefined = current.presets[type]?.[n] ?? current.presets[type]?.[current.renamed?.[type]?.[n] ?? ''];
    if (!preset && library && type === 'filament') {
      current = library;
      preset = library.presets.filament?.[n];
    }
    if (!preset) return undefined;
    if (key in preset) return preset[key];
    const parent: string | string[] | undefined = preset.inherits;
    n = Array.isArray(parent) ? parent[0] : parent;
  }
  return undefined;
}
