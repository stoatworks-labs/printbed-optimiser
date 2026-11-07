// Layout requests, served in this thread (tests, Node) or in a Web Worker (the page), with the same code.
// The worker keeps the parts' meshes by id, so a request names parts instead of resending them, and keeps the
// last Packer, whose footprint masks are the expensive part.
import type { BedSpec, Layout, LayoutSettings } from '../../types.ts';
import { staticGrid } from '../bed.ts';
import { Packer, type PackPart } from './pack.ts';

export interface LayoutJob {
  bed: BedSpec;
  /** Part ids with this job's quantities and heights; meshes were sent with `addParts`. */
  parts: Omit<PackPart, 'positions'>[];
  settings: LayoutSettings;
}

export type LayoutMessage =
  | { id: number; op: 'addParts'; parts: { id: string; positions: Float32Array }[] }
  | { id: number; op: 'max'; job: LayoutJob }
  | { id: number; op: 'layouts'; job: LayoutJob; kits: number[] };

export type LayoutReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

export class LayoutState {
  private meshes = new Map<string, Float32Array>();
  private packer: { key: string; packer: Packer } | null = null;

  handle(msg: LayoutMessage): unknown {
    switch (msg.op) {
      case 'addParts':
        for (const p of msg.parts) this.meshes.set(p.id, p.positions);
        return null;
      case 'max':
        return this.packerFor(msg.job).maxKits();
      case 'layouts': {
        const packer = this.packerFor(msg.job);
        return msg.kits.map((k) => packer.layoutFor(k));
      }
    }
  }

  private packerFor(job: LayoutJob): Packer {
    const key = JSON.stringify(job);
    if (this.packer?.key === key) return this.packer.packer;
    const parts: PackPart[] = job.parts.map((p) => {
      const positions = this.meshes.get(p.id);
      if (!positions) throw new Error(`Layout service has no mesh for part ${p.id}.`);
      return { ...p, positions };
    });
    const packer = new Packer(staticGrid(job.bed, job.settings.resolution, job.settings.edgeMargin), parts, job.settings);
    this.packer = { key, packer };
    return packer;
  }
}

export interface LayoutService {
  addParts(parts: { id: string; positions: Float32Array }[]): Promise<void>;
  max(job: LayoutJob): Promise<Layout | null>;
  layouts(job: LayoutJob, kits: number[]): Promise<(Layout | null)[]>;
  dispose(): void;
}

export class LocalLayoutService implements LayoutService {
  private state = new LayoutState();
  private n = 0;
  async addParts(parts: { id: string; positions: Float32Array }[]) {
    this.state.handle({ id: ++this.n, op: 'addParts', parts });
  }
  async max(job: LayoutJob) {
    return this.state.handle({ id: ++this.n, op: 'max', job }) as Layout | null;
  }
  async layouts(job: LayoutJob, kits: number[]) {
    return this.state.handle({ id: ++this.n, op: 'layouts', job, kits }) as (Layout | null)[];
  }
  dispose() {}
}

export class WorkerLayoutService implements LayoutService {
  private worker: Worker;
  private n = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor() {
    this.worker = new Worker(new URL('../../workers/layout.worker.ts', import.meta.url), { type: 'module', name: 'layout' });
    this.worker.onmessage = (e: MessageEvent<LayoutReply>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(new Error(e.data.error));
    };
  }

  private send<T>(msg: Omit<LayoutMessage, 'id'>, transfer: Transferable[] = []): Promise<T> {
    const id = ++this.n;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  async addParts(parts: { id: string; positions: Float32Array }[]) {
    // Copies: the page keeps its meshes for slicing and the 3D view.
    await this.send({ op: 'addParts', parts: parts.map((p) => ({ id: p.id, positions: p.positions.slice() })) } as Omit<LayoutMessage, 'id'>);
  }
  max(job: LayoutJob) {
    return this.send<Layout | null>({ op: 'max', job } as Omit<LayoutMessage, 'id'>);
  }
  layouts(job: LayoutJob, kits: number[]) {
    return this.send<(Layout | null)[]>({ op: 'layouts', job, kits } as Omit<LayoutMessage, 'id'>);
  }
  dispose() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('Layout worker stopped.'));
    this.pending.clear();
  }
}
