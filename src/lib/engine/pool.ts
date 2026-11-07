// A pool of slicer hosts. Each host is the Muon3D Slicer Engine's worker (OrcaSlicer's libslic3r in
// WebAssembly, AGPL-3.0) started by URL; this code only sends it messages (protocol v2) and never imports engine
// code. One host slices one plate at a time, so a count sweep runs on several hosts at once. Single-threaded
// hosts work on any page; the multithreaded engine would need a cross-origin isolated page and would fight the
// pool for cores.
import {
  EngineConnection,
  EngineRequestError,
  workerTransport,
  type Config,
  type EngineWarning,
  type GcodeStats,
  type HelloResult,
  type Toolpaths,
  type Transport,
} from '@muon3d/slicer-engine-protocol';

export interface SliceObject {
  name: string;
  positions: Float32Array;
}

export interface SliceJob {
  configs: { machine: Config; process: Config; filaments: Config[] };
  objects: SliceObject[];
  toolpaths?: boolean;
  keepGcode?: boolean;
}

export type SliceOutcome =
  | {
      ok: true;
      stats: GcodeStats;
      warnings: EngineWarning[];
      gcode: Uint8Array | null;
      toolpaths: Toolpaths | null;
      ms: number;
    }
  | { ok: false; code: number; message: string; objects?: string[]; ms: number };

/** Starts one host: a transport to it and a way to stop it. */
export type HostSpawner = () => { transport: Transport; terminate: () => void };

interface Host {
  connection: EngineConnection;
  terminate: () => void;
  ready: Promise<HelloResult>;
  busy: boolean;
  retire: boolean;
}

export class EnginePool {
  private hosts: Host[] = [];
  private queue: { job: SliceJob; resolve: (o: SliceOutcome) => void; reject: (e: unknown) => void }[] = [];
  private closed = false;
  hello: HelloResult | null = null;

  constructor(
    private readonly spawn: HostSpawner,
    readonly size: number,
    private readonly client = { name: 'printbed-optimiser', version: '0.1.0' },
  ) {}

  /** Starts the first host and loads its engine; resolves with its hello (licence, source, versions). */
  async start(): Promise<HelloResult> {
    const host = this.add();
    this.hello = await host.ready;
    return this.hello;
  }

  private add(): Host {
    const { transport, terminate } = this.spawn();
    const connection = new EngineConnection(transport);
    const host: Host = { connection, terminate, busy: false, retire: false, ready: null as unknown as Promise<HelloResult> };
    host.ready = (async () => {
      const hello = await connection.open(this.client, { required: ['slice', 'check'] });
      await connection.request('load', { variant: 'st' });
      return hello;
    })();
    this.hosts.push(host);
    return host;
  }

  slice(job: SliceJob): Promise<SliceOutcome> {
    if (this.closed) return Promise.reject(new Error('The slicer pool is closed.'));
    return new Promise((resolve, reject) => {
      this.queue.push({ job, resolve, reject });
      this.pump();
    });
  }

  /** Drop queued jobs (running slices finish; the engine cannot stop one midway). */
  clearQueue(): void {
    for (const q of this.queue.splice(0)) q.reject(new DOMException('Cancelled', 'AbortError'));
  }

  close(): void {
    this.closed = true;
    this.clearQueue();
    for (const h of this.hosts) h.terminate();
    this.hosts = [];
  }

  private pump(): void {
    while (this.queue.length) {
      let host = this.hosts.find((h) => !h.busy && !h.retire);
      if (!host && this.hosts.filter((h) => !h.retire).length < this.size) host = this.add();
      if (!host) return;
      const next = this.queue.shift()!;
      host.busy = true;
      void this.run(host, next.job).then(next.resolve, next.reject).finally(() => {
        host.busy = false;
        if (host.retire) this.drop(host);
        this.pump();
      });
    }
  }

  private drop(host: Host): void {
    host.terminate();
    this.hosts = this.hosts.filter((h) => h !== host);
  }

  private async run(host: Host, job: SliceJob): Promise<SliceOutcome> {
    const t0 = performance.now();
    let hello: HelloResult;
    try {
      hello = await host.ready;
    } catch (err) {
      host.retire = true;
      throw err;
    }
    try {
      const result = await host.connection.request('slice', {
        configs: job.configs,
        objects: job.objects.map((o) => ({ name: o.name, mesh: { positions: o.positions } })),
        output: { toolpaths: job.toolpaths ?? false, toolpathExtras: false },
      }, { transfer: job.objects.map((o) => o.positions.buffer as ArrayBuffer) }); // moved, not copied: callers make fresh meshes per job
      // wasm memory only grows: replace a host whose heap passed half its limit.
      const limit = hello.limits.maxHeapBytes;
      if (result.heapBytes && limit && result.heapBytes > limit / 2) host.retire = true;
      return {
        ok: true,
        stats: result.stats,
        warnings: result.warnings,
        gcode: job.keepGcode ? result.gcode : null,
        toolpaths: result.toolpaths,
        ms: performance.now() - t0,
      };
    } catch (err) {
      if (err instanceof EngineRequestError) {
        // Codes 1 and 2 leave the engine dead; negative codes are OrcaSlicer refusing the job.
        if (err.code === 1 || err.code === 2) host.retire = true;
        return { ok: false, code: err.code, message: err.message, objects: err.objects, ms: performance.now() - t0 };
      }
      host.retire = true;
      throw err;
    }
  }
}

/** Hosts as Web Workers, started from the engine folder named in slicer.json. */
export function browserSpawner(engineBase: URL, hostFile: string): HostSpawner {
  return () => {
    const worker = new Worker(new URL(hostFile, engineBase), { type: 'module', name: 'slicer-engine' });
    return { transport: workerTransport(worker), terminate: () => worker.terminate() };
  };
}
