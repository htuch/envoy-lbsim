import type { EdfInspection } from '@elbsim/protocol';
import { backendColor } from './colors';

/**
 * EDF scheduler state for the weighted round-robin / least-request path. Entries
 * are the min-heap ordered by deadline; the next pick is entry 0. The fast
 * unweighted "prepick" list is shown when present.
 */
export function EdfHeapView({ edf }: { edf: EdfInspection }): React.JSX.Element {
  const deadlines = edf.entries.map((e) => e.deadline);
  const min = Math.min(...deadlines, edf.currentTime);
  const max = Math.max(...deadlines, edf.currentTime);
  const span = max - min || 1;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          current_time{' '}
          <span className="font-mono tabular-nums text-foreground">
            {edf.currentTime.toFixed(3)}
          </span>
        </span>
        <span>{edf.entries.length} entries</span>
      </div>

      {edf.entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">Heap empty (no live weighted hosts).</p>
      ) : (
        <ul className="space-y-1">
          {edf.entries.map((e, i) => (
            <li
              key={e.backend}
              className={i === 0 ? 'rounded bg-accent/60 px-1.5 py-1' : 'px-1.5 py-1'}
            >
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="inline-block h-2 w-2 rounded-[2px]"
                    style={{ background: backendColor(e.backend) }}
                  />
                  <span className="font-mono tabular-nums">b{e.backend}</span>
                  {i === 0 && (
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      next
                    </span>
                  )}
                </span>
                <span className="font-mono tabular-nums text-muted-foreground">
                  w {e.weight.toFixed(3)} · d {e.deadline.toFixed(3)}
                </span>
              </div>
              <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${((e.deadline - min) / span) * 100}%`,
                    background: backendColor(e.backend),
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      {edf.prepick.length > 0 && (
        <p className="text-xs text-muted-foreground">
          prepick:{' '}
          <span className="font-mono tabular-nums text-foreground">
            {edf.prepick.map((b) => `b${b}`).join(' ')}
          </span>
        </p>
      )}
    </div>
  );
}
