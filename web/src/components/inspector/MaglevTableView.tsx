import type { MaglevInspection } from '@elbsim/protocol';
import { useMemo } from 'react';
import { backendColor } from './colors';
import { downsampleTable, slotShares } from './structure';

/** Number of slot samples drawn in the strip (the real table is far larger). */
const STRIP_BUCKETS = 320;

/**
 * Maglev lookup table: a downsampled slot strip colored by backend, plus the
 * realized per-backend slot share. The strip makes Maglev's interleaving and any
 * weight skew directly visible.
 */
export function MaglevTableView({ maglev }: { maglev: MaglevInspection }): React.JSX.Element {
  const strip = useMemo(() => downsampleTable(maglev.table, STRIP_BUCKETS), [maglev.table]);
  const shares = useMemo(() => slotShares(maglev), [maglev]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          table_size{' '}
          <span className="font-mono tabular-nums text-foreground">{maglev.tableSize}</span>
        </span>
        <span>{shares.length} backends</span>
      </div>

      <div
        role="img"
        aria-label="Maglev slot strip"
        className="flex h-6 w-full overflow-hidden rounded border"
      >
        {strip.map((backend, i) => (
          // Slots are positional in a static strip; the index is the stable key.
          // biome-ignore lint/suspicious/noArrayIndexKey: positional slot strip
          <div key={i} className="h-full flex-1" style={{ background: backendColor(backend) }} />
        ))}
      </div>

      <ul className="space-y-1">
        {shares.map((s) => (
          <li key={s.backend} className="flex items-center gap-2 text-xs">
            <span className="flex w-8 items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-[2px]"
                style={{ background: backendColor(s.backend) }}
              />
              <span className="font-mono tabular-nums">b{s.backend}</span>
            </span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full rounded-full"
                style={{ width: `${s.fraction * 100}%`, background: backendColor(s.backend) }}
              />
            </span>
            <span className="w-24 text-right font-mono tabular-nums text-muted-foreground">
              {s.count} · {(s.fraction * 100).toFixed(1)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
