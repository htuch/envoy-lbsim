import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import type { Series } from '@/lib/series';
import {
  makeTimelineOpts,
  seekTimeFromPlot,
  selectionFromPlot,
  type TimelineSync,
} from '@/lib/uplot-opts';
import { useSimStore } from '@/store/sim-store';

/**
 * One color and label for a derived line series (the per-gauge strips assign
 * their own palette index; derived strips name their lines explicitly because
 * they are not a per-entity fan-out but a handful of semantic curves).
 */
export interface DerivedLine {
  label: string;
  stroke: string;
}

/**
 * A derived timeline: the same hot-path rAF + `setData` loop as {@link Timeline},
 * but instead of reading a single gauge column it pulls its `{x, ys}` from a
 * caller-supplied `build` closure (e.g. fleet goodput, per-stage losses, the
 * selected envoy's latency percentiles). The builder reads the shared ring
 * buffers directly each frame, so 60fps frames never route through React.
 *
 * `revision` is a value that, when it changes identity, forces a remount of the
 * plot (e.g. the selected envoy changing for the latency strip). The `build`
 * closure is captured at mount; bump `revision` to re-capture it.
 *
 * Zoom is lock-step with the gauge strips: the strip pins its x scale to the
 * shared store window via the uPlot `range` fn and commits brushes back to it.
 */
export function DerivedTimeline({
  lines,
  build,
  revision,
  height = 96,
}: {
  lines: DerivedLine[];
  build: () => Series;
  revision?: unknown;
  height?: number;
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  // Keep the latest builder in a ref so the rAF loop always reads fresh closures
  // without re-running the mount effect on every render.
  const buildRef = useRef(build);
  buildRef.current = build;

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the explicit remount key; build is read via buildRef.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const width = host.clientWidth || 600;

    const sync: TimelineSync = {
      getWindowSec: () => {
        const sel = useSimStore.getState().selection;
        return sel ? [sel.fromMs / 1000, sel.toMs / 1000] : null;
      },
      onSelectSec: (minSec, maxSec) =>
        useSimStore.getState().setSelection({ fromMs: minSec * 1000, toMs: maxSec * 1000 }),
    };

    const opts = makeTimelineOpts(lines.length, width, height, sync);
    // Name and color the lines explicitly (makeTimelineOpts seeds `#e` labels and
    // the palette ramp; derived strips carry semantic labels/colors instead).
    for (let i = 0; i < lines.length; i++) {
      const series = opts.series[i + 1];
      const line = lines[i];
      if (series && line) {
        series.label = line.label;
        series.stroke = line.stroke;
      }
    }

    const initial: uPlot.AlignedData = [[], ...Array.from({ length: lines.length }, () => [])];
    const plot = new uPlot(opts, initial, host);

    const onMouseUp = (): void => {
      const window = selectionFromPlot(plot);
      if (window) sync.onSelectSec(window[0], window[1]);
      requestAnimationFrame(() => plot.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false));
    };
    plot.over.addEventListener('mouseup', onMouseUp);

    // Click-to-seek: a plain click (not a drag) moves the inspector to that
    // virtual instant via seek(); see Timeline for the full rationale.
    const onClick = (): void => {
      const timeMs = seekTimeFromPlot(plot);
      if (timeMs !== null) void useSimStore.getState().seek(timeMs);
    };
    plot.over.addEventListener('click', onClick);

    const applyView = (): void => {
      const sel = useSimStore.getState().selection;
      if (sel) {
        plot.setScale('x', { min: sel.fromMs / 1000, max: sel.toMs / 1000 });
        return;
      }
      const s = buildRef.current();
      const first = s.x[0];
      const last = s.x[s.x.length - 1];
      if (first == null || last == null) return;
      const max = last > first ? last : first + 1;
      plot.setScale('x', { min: first, max });
    };
    const unsubscribe = useSimStore.subscribe((state, prev) => {
      if (state.selection !== prev.selection) applyView();
    });

    let raf = 0;
    let lastLen = -1;
    let lastT = Number.NaN;
    const draw = (): void => {
      const s = buildRef.current();
      const t = s.x.length ? (s.x[s.x.length - 1] as number) : -1;
      // Redraw only when the series grew or rewound (seek backfill).
      if (s.x.length !== lastLen || t !== lastT) {
        plot.setData([s.x, ...s.ys]);
        lastLen = s.x.length;
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
      plot.over.removeEventListener('mouseup', onMouseUp);
      plot.over.removeEventListener('click', onClick);
      unsubscribe();
      plot.destroy();
    };
  }, [lines, height, revision]);

  return <div ref={hostRef} className="w-full" style={{ height }} />;
}
