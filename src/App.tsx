// The page: models, printer and goal on the left; the answer, the plate and the sweep on the right.
// Everything runs in this tab: the slicer in Web Workers (the Muon3D engine, started by URL), the packer in a
// worker of its own. Nothing is sent anywhere.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HelloResult } from '@muon3d/slicer-engine-protocol';
import type { PlateResult } from './types.ts';
import { loadFiles, setFlat, setQuantity, type Model } from './lib/app/models.ts';
import { SLICER_BASE, useProfiles } from './lib/app/useProfiles.ts';
import { bedFromMachine } from './lib/bed.ts';
import { partAdvice } from './lib/plan/advice.ts';
import { EnginePool, browserSpawner } from './lib/engine/pool.ts';
import { WorkerLayoutService, type LayoutService } from './lib/layout/service.ts';
import { objectsFor, optimise, plateFrom, type OptimiseRequest, type OptimiseResult } from './lib/plan/optimise.ts';
import { formatDuration, planQuantity, plateSeconds, recommend } from './lib/plan/sweep.ts';
import { download, plateTo3mf } from './lib/export/threemf-writer.ts';
import { ModelPanel } from './components/ModelPanel.tsx';
import { PrinterPanel } from './components/PrinterPanel.tsx';
import { GoalPanel, saveGoal, savedGoal, type Goal } from './components/GoalPanel.tsx';
import { BedView, PART_COLOURS } from './components/BedView.tsx';
import { SweepChart } from './components/SweepChart.tsx';
import { PlateTable } from './components/PlateTable.tsx';
import { Message } from './components/Messages.tsx';

type Run =
  | { status: 'idle' }
  | { status: 'running'; key: string; req: OptimiseRequest; message: string; done: number; total: number; plates: PlateResult[] }
  | { status: 'done'; key: string; req: OptimiseRequest; result: OptimiseResult }
  | { status: 'failed'; key: string; error: string };

/** Slicer hosts to run at once: each is a single-threaded engine with its own heap. */
function poolSize(): number {
  const cores = navigator.hardwareConcurrency || 4;
  const memGb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  return Math.max(1, Math.min(3, cores - 1, Math.floor(memGb / 2.5)));
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sortPlates = (ps: PlateResult[]) => [...ps].sort((a, b) => a.kits - b.kits);

export function App() {
  const profiles = useProfiles();
  const [models, setModels] = useState<Model[]>([]);
  const [loadErrors, setLoadErrors] = useState<string[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [goal, setGoalState] = useState<Goal>(savedGoal);
  const [run, setRun] = useState<Run>({ status: 'idle' });
  const [selected, setSelected] = useState<number | null>(null);
  const [hello, setHello] = useState<HelloResult | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const pool = useRef<{ pool: EnginePool; ready: Promise<HelloResult> } | null>(null);
  const layouts = useRef<LayoutService | null>(null);
  const abort = useRef<AbortController | null>(null);
  const extra = useRef(new Set<string>());

  const setGoal = (g: Goal) => {
    setGoalState(g);
    saveGoal(g);
  };

  useEffect(
    () => () => {
      pool.current?.pool.close();
      pool.current = null;
      layouts.current?.dispose();
      layouts.current = null;
    },
    [],
  );

  const getPool = useCallback(() => {
    if (!pool.current && profiles.lib) {
      const { engine } = profiles.lib.info;
      const p = new EnginePool(browserSpawner(new URL(engine.base, SLICER_BASE), engine.host), poolSize(), {
        name: 'printbed-optimiser',
        version: __APP_VERSION__.replace(/^v/, ''),
      });
      const ready = p.start();
      ready.then(
        (h) => {
          setHello(h);
          setEngineError(null);
        },
        (e) => {
          setEngineError(
            window.crossOriginIsolated
              ? `The slicer engine did not start: ${message(e)}`
              : 'The slicer engine needs a cross-origin isolated page, and this one was served without the Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers.',
          );
          if (pool.current?.pool === p) pool.current = null;
          p.close();
        },
      );
      pool.current = { pool: p, ready };
    }
    return pool.current;
  }, [profiles.lib]);

  // Start the engine as soon as there is something to slice, so the first run does not wait for 11 MB of wasm.
  useEffect(() => {
    if (models.length && profiles.lib) getPool();
  }, [models.length, profiles.lib, getPool]);

  const machine = profiles.choices?.machine ?? null;
  const bed = useMemo(() => (machine ? bedFromMachine(machine) : null), [machine]);
  const parts = useMemo(() => models.map((m) => m.part), [models]);
  const advice = useMemo(
    () => (bed && profiles.configs ? models.flatMap((m) => partAdvice(m.part, m.analysis, profiles.configs!.process, bed, m.bestFace)) : []),
    [models, bed, profiles.configs],
  );
  const kitPieces = models.reduce((s, m) => s + m.part.quantity, 0);
  const noun = models.length <= 1 && kitPieces <= 1 ? 'piece' : 'kit';

  // What a run depends on: if it changes, the plates shown are out of date.
  const key = JSON.stringify({
    parts: models.map((m) => [m.part.id, m.part.quantity, m.flat]),
    sel: profiles.selection,
    plate: profiles.plates?.choice.value,
    gap: goal.gap,
    edge: goal.edgeMargin,
    rot: goal.allowRotation,
  });

  const busy = run.status === 'running';
  const canRun = !busy && models.length > 0 && !!profiles.configs && !!bed && !profiles.loading && !loadingFiles;

  const onFiles = async (files: File[]) => {
    setLoadingFiles(true);
    const { models: added, errors } = await loadFiles(files);
    setLoadErrors(errors);
    setModels((ms) => [...ms, ...added]);
    setLoadingFiles(false);
  };

  const start = async () => {
    if (!canRun) return;
    const p = getPool();
    if (!p) return;
    if (!layouts.current) layouts.current = new WorkerLayoutService();
    const ac = new AbortController();
    abort.current = ac;
    extra.current.clear();
    const req: OptimiseRequest = {
      parts: models.map((m) => m.part),
      heights: Object.fromEntries(models.map((m) => [m.part.id, m.analysis.height])),
      minRectAngles: Object.fromEntries(models.map((m) => [m.part.id, m.analysis.minRectAngle])),
      bed: bed!,
      configs: profiles.configs!,
      settings: { gap: goal.gap, edgeMargin: goal.edgeMargin, heightGapPerMm: 0.05, allowRotation: goal.allowRotation, resolution: 0.5 },
    };
    setSelected(null);
    setRun({ status: 'running', key, req, message: 'Starting the slicer', done: 0, total: 1, plates: [] });
    try {
      await p.ready;
      const result = await optimise(
        req,
        p.pool,
        layouts.current,
        {
          progress: (msg, done, total) => setRun((r) => (r.status === 'running' ? { ...r, message: msg, done, total } : r)),
          plate: (plate) => setRun((r) => (r.status === 'running' ? { ...r, plates: sortPlates([...r.plates, plate]) } : r)),
        },
        ac.signal,
      );
      setRun({ status: 'done', key, req, result });
    } catch (e) {
      if (isAbort(e)) setRun({ status: 'idle' });
      else setRun({ status: 'failed', key, error: message(e) });
    } finally {
      abort.current = null;
      setStopping(false);
    }
  };

  // Queued slices are dropped at once; one already running finishes first (the engine cannot stop midway).
  const cancel = () => {
    setStopping(true);
    abort.current?.abort();
    pool.current?.pool.clearQueue();
  };

  const plates = run.status === 'done' ? run.result.plates : run.status === 'running' ? run.plates : [];
  const runParts = run.status === 'done' || run.status === 'running' ? run.req.parts : parts;
  const overheadSeconds = goal.overheadMin * 60;
  const maxPlateSeconds = goal.maxPlateHours ? goal.maxPlateHours * 3600 : null;
  const rec = useMemo(
    () => recommend(plates, { overheadSeconds, tolerance: goal.tolerancePct / 100, maxPlateSeconds }),
    [plates, overheadSeconds, goal.tolerancePct, maxPlateSeconds],
  );
  const plan = useMemo(
    () => (goal.mode === 'quantity' && run.status === 'done' ? planQuantity(plates, goal.quantity, { overheadSeconds, maxPlateSeconds }) : null),
    [goal.mode, goal.quantity, run.status, plates, overheadSeconds, maxPlateSeconds],
  );

  /** Lay out and slice one more count with the run's settings, so a number shown is a sliced one. */
  const slicePlate = useCallback(
    async (kits: number) => {
      if (run.status !== 'done' || !layouts.current || !pool.current) return;
      const tag = `${run.key}#${kits}`;
      if (extra.current.has(tag) || run.result.plates.some((p) => p.kits === kits)) return;
      extra.current.add(tag);
      const { req, result } = run;
      const job = {
        bed: req.bed,
        parts: req.parts.map((p) => ({ id: p.id, quantity: p.quantity, height: req.heights[p.id] ?? 0, minRectAngle: req.minRectAngles[p.id] ?? 0 })),
        settings: result.settings,
      };
      try {
        const [layout] = await layouts.current.layouts(job, [kits]);
        if (!layout) return;
        const objects = objectsFor(layout, req.parts);
        const plate = plateFrom(layout, await pool.current.pool.slice({ configs: req.configs, objects }), objects.length);
        setRun((r) =>
          r.status === 'done' && r.key === run.key && !r.result.plates.some((p) => p.kits === kits)
            ? { ...r, result: { ...r.result, plates: sortPlates([...r.result.plates, plate]) } }
            : r,
        );
      } catch (e) {
        if (!isAbort(e)) setEngineError(`Slicing ${kits} per plate: ${message(e)}`);
      }
    },
    [run],
  );

  // A quantity plan built on an interpolated count gets that count sliced, and settles on real numbers.
  useEffect(() => {
    if (plan) for (const p of plan.plates) if (p.estimated) void slicePlate(p.kits);
  }, [plan, slicePlate]);

  const shownKits = selected ?? rec.recommended?.kits ?? (plates.length ? plates[plates.length - 1].kits : null);
  const shown = plates.find((p) => p.kits === shownKits) ?? null;
  const stale = (run.status === 'done' || run.status === 'running') && run.key !== key;
  const title = models.length === 1 ? models[0].part.name : models.length ? `${models[0].part.name} and ${models.length - 1} more` : 'plate';
  const fileStem = title.replace(/[^\w.\- ]+/g, '_').trim() || 'plate';

  const export3mf = () => {
    if (!shown) return;
    download(plateTo3mf(shown.layout, runParts, `${title}, ${shown.kits} per plate`), `${fileStem}-${shown.kits}-per-plate.3mf`, 'model/3mf');
  };
  const exportGcode = async () => {
    if (!shown || run.status !== 'done' || !pool.current) return;
    setExporting('Slicing for G-code');
    try {
      const outcome = await pool.current.pool.slice({ configs: run.req.configs, objects: objectsFor(shown.layout, run.req.parts), keepGcode: true });
      if (!outcome.ok) throw new Error(`${outcome.message} (OrcaSlicer ${outcome.code})`);
      if (!outcome.gcode) throw new Error('the engine returned no G-code');
      download(outcome.gcode, `${fileStem}-${shown.kits}-per-plate.gcode`, 'text/x-gcode');
    } catch (e) {
      setEngineError(`G-code: ${message(e)}`);
    } finally {
      setExporting(null);
    }
  };

  const result = run.status === 'done' ? run.result : null;
  const probeErrors = result?.probes.filter((p) => !p.ok) ?? [];
  const brims = result?.probes.filter((p) => p.brim > 0) ?? [];
  const nameOf = (id: string) => runParts.find((p) => p.id === id)?.name ?? id;
  const rp = rec.recommended;
  const rpSeconds = rp ? plateSeconds(rp, overheadSeconds) : null;

  return (
    <div className="app">
      <header className="top">
        <h1>
          Printbed <span>Optimiser</span>
        </h1>
        <span className="pill">preview</span>
        <span className="tag">Lay out the plate and find how many to print at once, with OrcaSlicer's engine in your browser.</span>
        <span className="ver">{__APP_VERSION__}</span>
      </header>

      <div className="layout">
        <div className="col">
          <ModelPanel
            models={models}
            advice={advice}
            loadErrors={loadErrors}
            busy={busy || loadingFiles}
            onFiles={onFiles}
            onQuantity={(id, q) => setModels((ms) => ms.map((m) => (m.part.id === id ? setQuantity(m, q) : m)))}
            onFlat={(id, flat) => setModels((ms) => ms.map((m) => (m.part.id === id ? setFlat(m, flat) : m)))}
            onRemove={(id) => setModels((ms) => ms.filter((m) => m.part.id !== id))}
          />
          <PrinterPanel profiles={profiles} bed={bed} busy={busy} />
          <GoalPanel goal={goal} onChange={setGoal} busy={busy} kitNoun={noun} />
          <section className="card">
            {busy ? (
              <button type="button" className="btn big" onClick={cancel} disabled={stopping}>
                {stopping ? 'Stopping when the slices running now finish…' : 'Stop'}
              </button>
            ) : (
              <button type="button" className="btn primary big" disabled={!canRun} onClick={start}>
                {result && !stale ? 'Run again' : 'Find the best plate'}
              </button>
            )}
            {run.status === 'running' && (
              <div className="progress" aria-live="polite">
                <div className="bar">
                  <div style={{ width: `${Math.round((100 * run.done) / Math.max(1, run.total))}%` }} />
                </div>
                <div className="label">
                  <span>{run.message}</span>
                  <span>
                    {run.total > 1 && `${run.done} / ${run.total} · `}
                    {pool.current?.pool.size ?? 1} slicer{(pool.current?.pool.size ?? 1) > 1 ? 's' : ''} at once
                  </span>
                </div>
              </div>
            )}
            {!models.length && <p className="hint" style={{ margin: '8px 0 0' }}>Add a model to start.</p>}
            {engineError && <p className="banner small">{engineError}</p>}
            {run.status === 'failed' && <p className="banner small">The run stopped: {run.error}</p>}
          </section>
        </div>

        <div className="col">
          <section className="card">
            <h2>
              Answer
              {stale && <span className="aside">Models, printer, plate or spacing changed since this run: run again to update.</span>}
            </h2>
            {!plates.length && run.status !== 'running' && (
              <p className="muted" style={{ margin: 0 }}>
                {models.length
                  ? 'Find the best plate slices one kit, then the fullest plate, then the counts in between, and recommends the count with the shortest time per piece.'
                  : 'Drop a model, pick the printer, and the answer appears here.'}
              </p>
            )}
            {run.status === 'running' && !plates.length && <p className="muted" style={{ margin: 0 }}>{run.message}…</p>}
            {rp && rpSeconds !== null && (
              <>
                <div className="hero">
                  <div className="big">
                    {rp.kits} <small>{noun}s per plate</small>
                  </div>
                  <div className="stats">
                    <div className="stat">
                      <div className="v">{formatDuration(rpSeconds / rp.kits)}</div>
                      <div className="k">per {noun}</div>
                    </div>
                    <div className="stat">
                      <div className="v">{formatDuration(rpSeconds)}</div>
                      <div className="k">per plate</div>
                    </div>
                    {rp.filamentG !== null && (
                      <div className="stat">
                        <div className="v">{rp.filamentG.toFixed(0)} g</div>
                        <div className="k">filament per plate</div>
                      </div>
                    )}
                    <div className="stat">
                      <div className="v">{rp.objects}</div>
                      <div className="k">objects</div>
                    </div>
                  </div>
                </div>
                <p className="reason">
                  {busy ? 'So far: ' : ''}
                  {rec.reason}
                </p>
              </>
            )}
            {!rp && plates.length > 0 && !busy && <p className="muted">{rec.reason}</p>}
            {plan && (
              <div className="plan">
                <b>
                  {goal.quantity} {noun}
                  {goal.quantity === 1 ? '' : 's'}
                </b>{' '}
                in {plan.plates.length} plate{plan.plates.length === 1 ? '' : 's'} ({plan.plates.map((p) => p.kits).join(' + ')}): about{' '}
                <b>{formatDuration(plan.totalSeconds)}</b> one after another
                {plan.plates.some((p) => p.estimated) && <span className="faint"> · slicing the remaining plate sizes…</span>}
                <div className="actions" style={{ marginTop: 6 }}>
                  {[...new Set(plan.plates.map((p) => p.kits))].map((k) => (
                    <button key={k} type="button" className="btn" onClick={() => setSelected(k)} aria-pressed={shownKits === k}>
                      Show the {k}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {(probeErrors.length > 0 || (result?.notes.length ?? 0) > 0) && (
              <ul className="msgs" style={{ marginTop: 10 }}>
                {probeErrors.map((p) => (
                  <Message key={p.partId} level="error">
                    {nameOf(p.partId)} would not slice on its own: {p.error}
                  </Message>
                ))}
                {result!.notes.map((n) => (
                  <Message key={n} level="info">
                    {n}
                  </Message>
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <h2>
              Plate
              {shown && (
                <span className="aside">
                  {shown.kits} {noun}
                  {shown.kits === 1 ? '' : 's'} · {shown.objects} objects · {shown.layout.strategy === 'grid' ? 'grid' : `${shown.layout.strategy} packing`}
                  {shown.layout.spacing > 1 ? `, clearances ×${shown.layout.spacing}` : ''}
                </span>
              )}
            </h2>
            <BedView bed={run.status === 'done' || run.status === 'running' ? run.req.bed : bed} parts={runParts} layout={shown?.layout ?? null} caption={bed ? 'Drag to turn, scroll to zoom' : undefined} />
            {shown && (
              <>
                {runParts.length > 1 && (
                  <div className="legend">
                    {runParts.map((p, i) => (
                      <span key={p.id}>
                        <i style={{ background: PART_COLOURS[i % PART_COLOURS.length] }} /> {p.name} ×{p.quantity}
                      </span>
                    ))}
                  </div>
                )}
                <ul className="msgs" style={{ marginTop: 10 }}>
                  {!shown.ok && <Message level="error">OrcaSlicer refused this plate: {shown.error?.message}</Message>}
                  {shown.ok && !shown.warnings.length && <Message level="good">OrcaSlicer sliced this plate without a warning.</Message>}
                  {shown.warnings.map((w, i) => (
                    <Message key={i} level="warning">
                      {w.message}
                      {w.objects?.length ? <span className="faint"> ({w.objects.slice(0, 4).join(', ')}{w.objects.length > 4 ? ', …' : ''})</span> : null}
                    </Message>
                  ))}
                  {brims.length > 0 && (
                    <Message level="info">
                      Room left for the brim OrcaSlicer gives {brims.map((b) => `${nameOf(b.partId)} (${b.brim} mm)`).join(', ')}.
                    </Message>
                  )}
                </ul>
                <div className="actions" style={{ marginTop: 10 }}>
                  <button type="button" className="btn" onClick={export3mf} disabled={!shown.ok}>
                    Download 3MF
                  </button>
                  <button type="button" className="btn" onClick={exportGcode} disabled={!shown.ok || run.status !== 'done' || !!exporting}>
                    {exporting ?? 'Download G-code'}
                  </button>
                  <span className="hint" style={{ margin: 0, alignSelf: 'center' }}>
                    The 3MF opens in Bambu Studio or OrcaSlicer with every part in place; set the printer, plate and filament there.
                  </span>
                </div>
              </>
            )}
          </section>

          <section className="card">
            <h2>
              Time per {noun}
              <span className="aside">every point is a plate OrcaSlicer sliced</span>
            </h2>
            <SweepChart
              plates={plates}
              overheadSeconds={overheadSeconds}
              recommended={rp?.kits ?? null}
              fastest={rec.fastest?.kits ?? null}
              selected={shownKits}
              noun={noun}
              onSelect={setSelected}
            />
          </section>

          {plates.length > 0 && (
            <section className="card">
              <h2>Plates sliced</h2>
              <PlateTable
                plates={plates}
                overheadSeconds={overheadSeconds}
                maxPlateSeconds={maxPlateSeconds}
                recommended={rp?.kits ?? null}
                fastest={rec.fastest?.kits ?? null}
                selected={shownKits}
                noun={noun}
                onSelect={setSelected}
              />
            </section>
          )}
        </div>
      </div>

      <EngineNotice hello={hello} info={profiles.lib?.info.engine ?? null} />
    </div>
  );
}

function EngineNotice({ hello, info }: { hello: HelloResult | null; info: { version: string; license: string; source: string; sourceTag: string; orca: { version: string } } | null }) {
  const e = hello?.engine;
  const version = e?.version ?? info?.version;
  const orca = e?.orca.version ?? info?.orca.version;
  const licence = e?.license ?? info?.license ?? 'AGPL-3.0-only';
  const source = e?.source ?? (info ? `${info.source}/tree/${info.sourceTag}` : null);
  return (
    <footer className="engine">
      <p>
        Slicing runs in this tab with OrcaSlicer {orca ?? ''}'s engine (libslic3r), compiled to WebAssembly by the{' '}
        <a href="https://github.com/Muon-3D/muon3d-slicer-engine">Muon3D Slicer Engine</a> {version ?? ''}. The engine is licensed {licence}
        {source && (
          <>
            ; the source of the exact build this page runs is <a href={source}>here</a>
          </>
        )}
        {e?.notice && (
          <>
            , with its <a href={e.notice}>notices</a>
          </>
        )}
        . This page only sends it messages. Your models never leave this device.
      </p>
      <p>Print times are OrcaSlicer's estimates plus the time between plates you set. Check the first plate before leaving a long job.</p>
    </footer>
  );
}
