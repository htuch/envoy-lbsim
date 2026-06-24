import type { Series } from '@/lib/series';
import { type DerivedLine, DerivedTimeline } from './DerivedTimeline';

/**
 * A labeled derived-series strip: a title plus a semantic legend (one swatch per
 * named line) over the live {@link DerivedTimeline} canvas. The per-gauge
 * {@link TimelineStrip} fans out one line per entity; a derived strip instead
 * carries a small fixed set of named curves (e.g. p50/p90/p99, or the loss
 * stages), so its legend names them rather than numbering entities.
 */
export function DerivedStrip({
  label,
  lines,
  build,
  revision,
  height = 96,
}: {
  label: string;
  lines: DerivedLine[];
  build: () => Series;
  revision?: unknown;
  height?: number;
}): React.JSX.Element {
  return (
    <section className="rounded-md border bg-card">
      <header className="flex items-center justify-between border-b px-2.5 py-1.5">
        <h3 className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </h3>
        <ul className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {lines.map((line) => (
            <li key={line.label} className="flex items-center gap-1">
              <span
                className="inline-block h-1.5 w-2.5 rounded-sm"
                style={{ backgroundColor: line.stroke }}
              />
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                {line.label}
              </span>
            </li>
          ))}
        </ul>
      </header>
      <div className="px-1 py-1">
        <DerivedTimeline lines={lines} build={build} revision={revision} height={height} />
      </div>
    </section>
  );
}
