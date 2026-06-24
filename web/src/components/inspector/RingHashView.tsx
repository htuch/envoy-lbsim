import type { RingHashInspection } from '@elbsim/protocol';
import { useMemo } from 'react';
import { backendColor } from './colors';
import { ringPoints } from './structure';

/** Max ticks drawn around the ring; a dense ring is downsampled to this. */
const MAX_TICKS = 360;
const CENTER = 100;
const INNER = 74;
const OUTER = 92;

/**
 * Consistent-hash ring: each point is a tick at its hash angle, colored by the
 * backend that owns that arc. The legend tallies every point (pre-downsampling)
 * so weight skew in ring ownership is visible.
 */
export function RingHashView({ ring }: { ring: RingHashInspection }): React.JSX.Element {
  const ticks = useMemo(() => ringPoints(ring, MAX_TICKS), [ring]);
  const counts = useMemo(() => {
    const map = new Map<number, number>();
    for (const e of ring.entries) map.set(e.backend, (map.get(e.backend) ?? 0) + 1);
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [ring.entries]);

  return (
    <div className="flex flex-wrap items-center gap-4">
      <svg
        viewBox="0 0 200 200"
        className="h-44 w-44 shrink-0"
        role="img"
        aria-label={`Hash ring with ${ring.size} points`}
      >
        <circle
          cx={CENTER}
          cy={CENTER}
          r={(INNER + OUTER) / 2}
          fill="none"
          stroke="var(--color-border)"
          strokeWidth={0.5}
        />
        {ticks.map((pt) => {
          const angle = pt.fraction * 2 * Math.PI - Math.PI / 2;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          return (
            <line
              key={pt.id}
              x1={CENTER + INNER * cos}
              y1={CENTER + INNER * sin}
              x2={CENTER + OUTER * cos}
              y2={CENTER + OUTER * sin}
              stroke={backendColor(pt.backend)}
              strokeWidth={1}
            />
          );
        })}
      </svg>

      <div className="min-w-40 space-y-1">
        <p className="text-xs text-muted-foreground">
          ring size <span className="font-mono tabular-nums text-foreground">{ring.size}</span>{' '}
          points
        </p>
        <ul className="space-y-0.5">
          {counts.map(([backend, count]) => (
            <li key={backend} className="flex items-center gap-1.5 text-xs">
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-[2px]"
                style={{ background: backendColor(backend) }}
              />
              <span className="font-mono tabular-nums">b{backend}</span>
              <span className="font-mono tabular-nums text-muted-foreground">{count}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
