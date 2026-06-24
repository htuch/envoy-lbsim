import type { EntityKind } from '@elbsim/protocol';
import { seriesColor } from '@/lib/uplot-opts';
import { useSimStore } from '@/store/sim-store';
import { Timeline } from './Timeline';

/**
 * A labeled timeline strip: a gauge title, a compact per-entity color legend,
 * and the live uPlot canvas. The legend caps at a handful of swatches so dense
 * fleets stay legible rather than turning into a wall of chips.
 */
const MAX_LEGEND = 8;

export function TimelineStrip({
  kind,
  gauge,
  label,
  unit,
  height = 96,
}: {
  kind: EntityKind;
  gauge: string;
  label: string;
  /** Measurement unit for the strip, rendered subtly beside the title. */
  unit: string;
  height?: number;
}): React.JSX.Element {
  const entityCount = useSimStore((s) => s.rings.get(kind)?.spec.entityCount ?? 0);
  const shown = Math.min(entityCount, MAX_LEGEND);
  return (
    <section className="rounded-md border bg-card">
      <header className="flex items-center justify-between border-b px-2.5 py-1.5">
        <h3 className="flex items-baseline gap-1.5 font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
          <span className="text-[9px] font-normal lowercase tracking-normal text-muted-foreground/70">
            {unit}
          </span>
        </h3>
        <ul className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {Array.from({ length: shown }, (_, e) => (
            // Entity ids are dense, stable zero-based indices (protocol/ids.ts),
            // so the index is a legitimate stable key here.
            // biome-ignore lint/suspicious/noArrayIndexKey: entity index is the stable id
            <li key={e} className="flex items-center gap-1">
              <span
                className="inline-block h-1.5 w-2.5 rounded-sm"
                style={{ backgroundColor: seriesColor(e) }}
              />
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">#{e}</span>
            </li>
          ))}
          {entityCount > MAX_LEGEND && (
            <li className="font-mono text-[10px] text-muted-foreground">
              +{entityCount - MAX_LEGEND}
            </li>
          )}
        </ul>
      </header>
      <div className="px-1 py-1">
        <Timeline kind={kind} gauge={gauge} height={height} />
      </div>
    </section>
  );
}
