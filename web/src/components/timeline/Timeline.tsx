import { type EntityKind, gaugeIndex } from '@elbsim/protocol';
import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import { buildSeries } from '@/lib/series';
import {
  makeTimelineOpts,
  seekTimeFromPlot,
  selectionFromPlot,
  type TimelineSync,
} from '@/lib/uplot-opts';
import { useSimStore } from '@/store/sim-store';

/**
 * One gauge timeline strip. This is the hot path: a uPlot canvas fed by a
 * `requestAnimationFrame` loop that reads the shared ring buffer directly and
 * pushes data straight into the plot. It never routes 60fps frames through React
 * state; the component re-mounts the plot only when the underlying ring changes
 * (a new run), per ARCHITECTURE.md's hot/cold split.
 *
 * Zoom is lock-step across strips: every strip pins its x scale to the single
 * shared selection in the store (via the uPlot `range` fn), so brushing one strip
 * zooms them all to the identical window and freezes it while live data streams.
 */
export function Timeline({
  kind,
  gauge,
  scale = 1,
  height = 96,
}: {
  kind: EntityKind;
  gauge: string;
  /**
   * Scale factor applied to raw gauge values. Use `1000 / sampleIntervalMs`
   * to convert per-interval counts to req/s. Defaults to 1 (no scaling).
   */
  scale?: number;
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

    const sync: TimelineSync = {
      getWindowSec: () => {
        const sel = useSimStore.getState().selection;
        return sel ? [sel.fromMs / 1000, sel.toMs / 1000] : null;
      },
      onSelectSec: (minSec, maxSec) =>
        useSimStore.getState().setSelection({ fromMs: minSec * 1000, toMs: maxSec * 1000 }),
    };

    const initial: uPlot.AlignedData = [[], ...Array.from({ length: entityCount }, () => [])];
    const plot = new uPlot(makeTimelineOpts(entityCount, width, height, sync), initial, host);

    // Brush capture: the drag shows uPlot's live select highlight; on release we
    // turn the region into the shared window. The highlight is cleared on the
    // next frame (after uPlot's own document-level mouseup finalizes the select)
    // since the committed window is shown by zooming every strip instead.
    const onMouseUp = (): void => {
      const window = selectionFromPlot(plot);
      if (window) sync.onSelectSec(window[0], window[1]);
      requestAnimationFrame(() => plot.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false));
    };
    plot.over.addEventListener('mouseup', onMouseUp);

    // Click-to-seek: a plain click (not a drag) moves the inspector to that
    // virtual instant. seek() pauses and sets the virtual clock; the dock's
    // pause/seek effect then refreshes the inspection at that time. A drag is a
    // brush (handled above), so seekTimeFromPlot returns null for it.
    const onClick = (): void => {
      const timeMs = seekTimeFromPlot(plot);
      if (timeMs !== null) void useSimStore.getState().seek(timeMs);
    };
    plot.over.addEventListener('click', onClick);

    // Lock step: when the shared selection changes, every strip snaps its x
    // scale to the same target in unison (the window when set, the live data
    // extent when cleared). `setScale` is explicit because a bare `redraw` does
    // not re-run the range fn while paused.
    const applyView = (): void => {
      const sel = useSimStore.getState().selection;
      if (sel) {
        plot.setScale('x', { min: sel.fromMs / 1000, max: sel.toMs / 1000 });
        return;
      }
      const latest = ring.latest();
      if (!latest) return;
      const first = ring.frameAt(0).t;
      const min = first / 1000;
      const max = latest.t > first ? latest.t / 1000 : min + 1;
      plot.setScale('x', { min, max });
    };
    const unsubscribe = useSimStore.subscribe((state, prev) => {
      if (state.selection !== prev.selection) applyView();
    });

    let raf = 0;
    let lastSize = -1;
    let lastT = Number.NaN;
    const draw = (): void => {
      const size = ring.size();
      const latest = ring.latest();
      const t = latest ? latest.t : -1;
      // Redraw only when the buffer advanced or was rewound (seek backfill).
      if (size !== lastSize || t !== lastT) {
        const s = buildSeries(ring, col, scale);
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
      plot.over.removeEventListener('mouseup', onMouseUp);
      plot.over.removeEventListener('click', onClick);
      unsubscribe();
      plot.destroy();
    };
  }, [ring, kind, gauge, scale, height]);

  return <div ref={hostRef} className="w-full" style={{ height }} />;
}
