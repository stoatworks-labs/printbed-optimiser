// What to optimise for. The first group only re-reads the sliced plates, so changing it updates the answer at
// once; the spacing group changes where parts go, so it needs a new run.
export interface Goal {
  mode: 'fill' | 'quantity';
  quantity: number;
  overheadMin: number;
  maxPlateHours: number | null;
  tolerancePct: number;
  gap: number;
  edgeMargin: number;
  allowRotation: boolean;
}

export const DEFAULT_GOAL: Goal = {
  mode: 'fill',
  quantity: 50,
  overheadMin: 5,
  maxPlateHours: null,
  tolerancePct: 5,
  gap: 6,
  edgeMargin: 5,
  allowRotation: true,
};

const KEY = 'printbed-optimiser:goal';

export function savedGoal(): Goal {
  try {
    const g = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Goal> | null;
    if (g && typeof g === 'object') return { ...DEFAULT_GOAL, ...g };
  } catch {
    // storage unavailable: defaults
  }
  return DEFAULT_GOAL;
}

export function saveGoal(g: Goal) {
  try {
    localStorage.setItem(KEY, JSON.stringify(g));
  } catch {
    // not remembered
  }
}

function Num({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  disabled,
  placeholder,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="field">
      <span>
        {label}
        {unit && <span className="faint"> ({unit})</span>}
      </span>
      <input
        type="number"
        value={value ?? ''}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => {
          if (e.target.value === '') return onChange(null);
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
        }}
      />
    </label>
  );
}

export function GoalPanel({ goal, onChange, busy, kitNoun }: { goal: Goal; onChange: (g: Goal) => void; busy: boolean; kitNoun: string }) {
  const set = <K extends keyof Goal>(k: K, v: Goal[K]) => onChange({ ...goal, [k]: v });
  return (
    <section className="card">
      <h2>Goal</h2>
      <div className="seg" role="radiogroup" aria-label="Goal">
        <label>
          <input type="radio" name="mode" checked={goal.mode === 'fill'} onChange={() => set('mode', 'fill')} />
          Best plate
        </label>
        <label>
          <input type="radio" name="mode" checked={goal.mode === 'quantity'} onChange={() => set('mode', 'quantity')} />
          Make a number
        </label>
      </div>
      {goal.mode === 'quantity' && (
        <Num label={`${kitNoun[0].toUpperCase()}${kitNoun.slice(1)}s to make`} value={goal.quantity} min={1} max={5000} onChange={(v) => set('quantity', v ?? 1)} />
      )}
      <div className="grid2">
        <Num label="Time between plates" unit="min" value={goal.overheadMin} min={0} max={240} onChange={(v) => set('overheadMin', v ?? 0)} />
        <Num label="Longest plate" unit="h" value={goal.maxPlateHours} min={0.5} max={240} step={0.5} placeholder="no limit" onChange={(v) => set('maxPlateHours', v)} />
      </div>
      <Num label="Fewer per plate if within" unit="% of the fastest" value={goal.tolerancePct} min={0} max={50} step={0.5} onChange={(v) => set('tolerancePct', v ?? 0)} />
      <p className="hint">
        A smaller plate risks fewer parts if a print fails. These three re-read the plates already sliced, so the answer changes at once.
      </p>
      <details className="more">
        <summary>Spacing</summary>
        <div className="grid2">
          <Num label="Gap between parts" unit="mm" value={goal.gap} min={1} max={50} step={0.5} disabled={busy} onChange={(v) => set('gap', v ?? 6)} />
          <Num label="Edge margin" unit="mm" value={goal.edgeMargin} min={0} max={50} step={0.5} disabled={busy} onChange={(v) => set('edgeMargin', v ?? 5)} />
        </div>
        <label className="toggle" style={{ marginBottom: 8 }}>
          <input type="checkbox" checked={goal.allowRotation} disabled={busy} onChange={(e) => set('allowRotation', e.target.checked)} />
          Let parts turn to fit
        </label>
        <p className="hint">Room is added for each part's brim and, for tall parts, a little more. Changing these needs a new run.</p>
      </details>
    </section>
  );
}
