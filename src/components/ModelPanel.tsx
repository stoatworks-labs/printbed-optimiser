// The models: drop or pick files, set how many of each make one kit, lay a part flat, read what its geometry says.
import { useState } from 'react';
import type { Advice } from '../types.ts';
import type { Model } from '../lib/app/models.ts';
import { PART_COLOURS } from './BedView.tsx';
import { Message } from './Messages.tsx';

interface Props {
  models: Model[];
  advice: Advice[];
  loadErrors: string[];
  busy: boolean;
  onFiles: (files: File[]) => void;
  onQuantity: (id: string, q: number) => void;
  onFlat: (id: string, flat: boolean) => void;
  onRemove: (id: string) => void;
}

const mm = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1));

export function ModelPanel({ models, advice, loadErrors, busy, onFiles, onQuantity, onFlat, onRemove }: Props) {
  const [over, setOver] = useState(false);
  const pick = (list: FileList | null) => {
    const files = [...(list ?? [])].filter((f) => /\.(stl|3mf)$/i.test(f.name));
    if (files.length) onFiles(files);
  };
  return (
    <section className="card">
      <h2>
        Models
        {models.length > 0 && (models.length > 1 || models[0].part.quantity > 1) && (
          <span className="aside">one kit = {models.reduce((s, m) => s + m.part.quantity, 0)} pieces</span>
        )}
      </h2>
      <label
        className={`drop${over ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          pick(e.dataTransfer.files);
        }}
      >
        <input type="file" accept=".stl,.3mf,model/stl,model/3mf" multiple disabled={busy} onChange={(e) => (pick(e.target.files), (e.target.value = ''))} />
        <strong>Drop STL or 3MF files</strong> or click to choose
        <span className="small">They stay on this device: the slicer runs in this tab.</span>
      </label>
      {loadErrors.length > 0 && (
        <ul className="msgs">
          {loadErrors.map((e) => (
            <Message key={e} level="error">
              {e}
            </Message>
          ))}
        </ul>
      )}
      {models.length > 0 && (
        <ul className="models">
          {models.map((m, i) => {
            const mine = advice.filter((a) => a.partId === m.part.id);
            return (
              <li className="model" key={m.part.id}>
                <div className="row">
                  <span className="swatch" style={{ background: PART_COLOURS[i % PART_COLOURS.length] }} aria-hidden="true" />
                  <span className="name" title={`${m.part.name} (${m.part.source})`}>
                    {m.part.name}
                  </span>
                  <button type="button" className="icon-btn" aria-label={`Remove ${m.part.name}`} disabled={busy} onClick={() => onRemove(m.part.id)}>
                    ×
                  </button>
                </div>
                <div className="meta">
                  {mm(m.part.size[0])} × {mm(m.part.size[1])} × {mm(m.part.size[2])} mm · {m.part.triangles.toLocaleString()} triangles
                </div>
                <div className="controls">
                  <span className="qty" title="Copies of this part in one kit">
                    <button type="button" aria-label="One fewer" disabled={busy || m.part.quantity <= 1} onClick={() => onQuantity(m.part.id, m.part.quantity - 1)}>
                      −
                    </button>
                    <input
                      type="number"
                      min={1}
                      max={500}
                      aria-label={`Copies of ${m.part.name} per kit`}
                      value={m.part.quantity}
                      disabled={busy}
                      onChange={(e) => {
                        const q = Math.round(Number(e.target.value));
                        if (q >= 1 && q <= 500) onQuantity(m.part.id, q);
                      }}
                    />
                    <button type="button" aria-label="One more" disabled={busy || m.part.quantity >= 500} onClick={() => onQuantity(m.part.id, m.part.quantity + 1)}>
                      +
                    </button>
                  </span>
                  <span className="faint small">per kit</span>
                  <label className="toggle">
                    <input type="checkbox" checked={m.flat} disabled={busy} onChange={(e) => onFlat(m.part.id, e.target.checked)} />
                    Lay flat
                  </label>
                </div>
                {mine.length > 0 && (
                  <ul className="msgs">
                    {mine.map((a) => (
                      <Message key={a.message} level={a.level}>
                        {a.message}
                      </Message>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
