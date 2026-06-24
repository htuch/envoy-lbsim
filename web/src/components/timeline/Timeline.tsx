import { type EntityKind, gaugeIndex } from '@elbsim/protocol';
import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import { buildSeries } from '@/lib/series';
import { makeTimelineOpts } from '@/lib/uplot-opts';
import { useSimStore } from '@/store/sim-store';

/**
 * One gauge timeline strip. This is the hot path: a uPlot canvas fed by a
 * `requestAnimationFrame` loop that reads the shared ring buffer directly and
 * pushes data straight into the plot. It never routes 60fps frames through React
 * state; the component re-mounts the plot only when the underlying ring changes
 * (a new run), per ARCHITECTURE.md's hot/cold split.
 */
export function Timeline({
  kind,
  gauge,
  height = 96,
}: {
  kind: EntityKind;
  gauge: string;
  height?: number;
}): React.JSX.Element {
  const ring = useSimStore((s) => s.rings.get(kind));
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !ring) return;
    const col = gaugeIndex(kind, gauge);
    const entityCount = ring.spec.entityCount;
    const width = host.clientWidth || 600;
    const initial: uPlot.AlignedData = [[], ...Array.from({ length: entityCount }, () => [])];
    const plot = new uPlot(makeTimelineOpts(entityCount, width, height), initial, host);

    let raf = 0;
    let lastSize = -1;
    let lastT = Number.NaN;
    const draw = (): void => {
      const size = ring.size();
      const latest = ring.latest();
      const t = latest ? latest.t : -1;
      // Redraw only when the buffer advanced or was rewound (seek backfill).
      if (size !== lastSize || t !== lastT) {
        const s = buildSeries(ring, col);
        plot.setData([s.x, ...s.ys]);
        lastSize = size;
        lastT = t;
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    const onResize = (): void => plot.setSize({ width: host.clientWidth || width, height });
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      plot.destroy();
    };
  }, [ring, kind, gauge, height]);

  return <div ref={hostRef} className="w-full" style={{ height }} />;
}
