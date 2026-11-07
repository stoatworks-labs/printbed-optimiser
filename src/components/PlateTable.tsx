// Every sliced plate: the chart's numbers as a table. A row click shows that plate.
import type { PlateResult } from '../types.ts';
import { formatDuration, plateSeconds } from '../lib/plan/sweep.ts';

interface Props {
  plates: PlateResult[];
  overheadSeconds: number;
  maxPlateSeconds: number | null;
  recommended: number | null;
  fastest: number | null;
  selected: number | null;
  noun: string;
  onSelect: (kits: number) => void;
}

export function PlateTable({ plates, overheadSeconds, maxPlateSeconds, recommended, fastest, selected, noun, onSelect }: Props) {
  const anyCost = plates.some((p) => p.filamentCost);
  return (
    <div className="table-wrap">
      <table className="plates">
        <thead>
          <tr>
            <th className="l">{noun[0].toUpperCase() + noun.slice(1)}s per plate</th>
            <th>Objects</th>
            <th>Plate time</th>
            <th>Per {noun}</th>
            <th>Filament</th>
            {anyCost && <th>Cost</th>}
            <th>Layers</th>
            <th className="l">OrcaSlicer</th>
          </tr>
        </thead>
        <tbody>
          {plates.map((p) => {
            const s = plateSeconds(p, overheadSeconds);
            const over = s !== null && maxPlateSeconds !== null && s > maxPlateSeconds;
            return (
              <tr
                key={p.kits}
                className={p.kits === selected ? 'selected' : ''}
                onClick={() => onSelect(p.kits)}
                tabIndex={0}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(p.kits))}
                aria-selected={p.kits === selected}
              >
                <td className="l">
                  {p.kits}
                  {p.kits === recommended && <span className="badge rec">Recommended</span>}
                  {p.kits === fastest && p.kits !== recommended && <span className="badge fast">Fastest</span>}
                </td>
                <td>{p.objects}</td>
                <td>
                  {formatDuration(s)}
                  {over && <span className="faint"> (over limit)</span>}
                </td>
                <td>{s !== null ? formatDuration(s / p.kits) : '—'}</td>
                <td>{p.filamentG !== null ? `${p.filamentG.toFixed(0)} g` : '—'}</td>
                {anyCost && <td>{p.filamentCost ? p.filamentCost.toFixed(2) : '—'}</td>}
                <td>{p.layers ?? '—'}</td>
                <td className="l">
                  <span className="status-cell">
                    {!p.ok ? (
                      <>
                        <span className="icon fail" aria-hidden="true">✕</span> Refused: {p.error?.message}
                      </>
                    ) : p.warnings.length ? (
                      <>
                        <span className="icon warn" aria-hidden="true">!</span> {p.warnings.length} warning{p.warnings.length > 1 ? 's' : ''}
                      </>
                    ) : (
                      <>
                        <span className="icon ok" aria-hidden="true">✓</span> Clean
                      </>
                    )}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
