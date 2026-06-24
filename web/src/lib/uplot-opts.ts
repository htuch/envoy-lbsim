import type uPlot from 'uplot';

/**
 * Series palette for the timeline strips: distinct, high-chroma hues that stay
 * legible on the dark instrument background and read as a set rather than a
 * rainbow. Cycled when an entity kind has more members than colors.
 */
export const SERIES_COLORS = [
  '#38bdf8', // sky
  '#f472b6', // pink
  '#a3e635', // lime
  '#fbbf24', // amber
  '#c084fc', // violet
  '#34d399', // emerald
  '#fb7185', // rose
  '#60a5fa', // blue
] as const;

export function seriesColor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length] as string;
}

/** Minimum drag width (px) that counts as a brush rather than a stray click. */
export const MIN_DRAG_PX = 4;

/**
 * The lock-step zoom contract a strip is wired with. `getWindowSec` is the
 * single shared x-window (seconds) every strip renders, so a brush on one zooms
 * all of them identically; `onSelectSec` commits a freshly dragged window. The
 * lock-step is driven entirely by this shared window (the store), not uPlot's
 * own cursor-sync, which would mirror the transient drag-select band across
 * strips. Cross-strip crosshair sync is a deliberate later nicety.
 */
export interface TimelineSync {
  /** Current committed x-window [min,max] in seconds, or null to fit the data. */
  getWindowSec: () => [number, number] | null;
  /** Commit a dragged x-window (seconds) as the new shared selection. */
  onSelectSec: (minSec: number, maxSec: number) => void;
}

/** The uPlot surface `selectionFromPlot` reads to turn a drag into a window. */
export interface SelectablePlot {
  select: { left: number; width: number };
  posToVal: (pos: number, scaleKey: string) => number;
}

/**
 * Convert a finished drag-select region into an x-window in seconds, or null if
 * the drag was too small to count. Pure, so the brush math is unit-testable
 * without a live canvas.
 */
export function selectionFromPlot(u: SelectablePlot): [number, number] | null {
  const { left, width } = u.select;
  if (width <= MIN_DRAG_PX) return null;
  const a = u.posToVal(left, 'x');
  const b = u.posToVal(left + width, 'x');
  return a <= b ? [a, b] : [b, a];
}

/** The uPlot surface `seekTimeFromPlot` reads to turn a plain click into a time. */
export interface ClickablePlot {
  /** Finished drag-select region; `width` distinguishes a click from a brush. */
  select: { width: number };
  /** Cursor position in pixels relative to the plotting area. */
  cursor: { left?: number };
  posToVal: (pos: number, scaleKey: string) => number;
}

/**
 * Map a plain click on a timeline (NOT a brush-drag) to a virtual time in
 * milliseconds, or null when the gesture was a drag (select width over the
 * threshold) or the cursor is off the plot. Pure, so the click-to-seek math is
 * unit-testable without a live canvas. Shared by every strip so clicking any
 * timeline moves the inspector to that instant.
 */
export function seekTimeFromPlot(u: ClickablePlot): number | null {
  // A committed drag (brush) is not a seek; the mouseup brush logic owns it.
  if (u.select.width > MIN_DRAG_PX) return null;
  const left = u.cursor.left;
  if (left == null || left < 0) return null;
  // posToVal returns seconds (the x axis is virtual seconds); seek wants ms.
  return u.posToVal(left, 'x') * 1000;
}

/**
 * Build dense, axis-light uPlot options for one gauge strip: `entityCount` line
 * series over a virtual-time (seconds) x axis, no legend, hairline grid. When
 * `sync` is supplied the strip joins the lock-step zoom group: drag brushes a
 * window (without per-plot rescaling — `setScale: false`), and the x scale is
 * pinned to the shared window so it stays frozen while live data streams in.
 * Kept pure so the wiring is unit-testable without a canvas.
 */
export function makeTimelineOpts(
  entityCount: number,
  width: number,
  height: number,
  sync?: TimelineSync,
): uPlot.Options {
  const axisColor = '#3f3f46'; // zinc-700, hairline grid/ticks
  const labelColor = '#a1a1aa'; // zinc-400
  const series: uPlot.Series[] = [{ label: 't' }];
  for (let e = 0; e < entityCount; e++) {
    series.push({
      label: `#${e}`,
      stroke: seriesColor(e),
      width: 1,
      points: { show: false },
    });
  }

  const cursor: uPlot.Cursor = { y: false, points: { show: false } };
  const xScale: uPlot.Scale = { time: false };
  if (sync) {
    // Drag brushes a window for capture only (`setScale: false`); the actual
    // zoom is applied uniformly across strips from the shared store window.
    cursor.drag = { x: true, y: false, setScale: false };
    xScale.range = (_u, dataMin, dataMax) => {
      const window = sync.getWindowSec();
      if (window) return window;
      if (dataMin == null || dataMax == null) return [0, 1];
      return [dataMin, dataMax];
    };
  }

  return {
    width: Math.max(width, 1),
    height: Math.max(height, 1),
    legend: { show: false },
    cursor,
    scales: { x: xScale },
    series,
    axes: [
      {
        stroke: labelColor,
        grid: { stroke: axisColor, width: 1 },
        ticks: { stroke: axisColor, width: 1 },
        font: '10px ui-monospace, monospace',
        size: 28,
      },
      {
        stroke: labelColor,
        grid: { stroke: axisColor, width: 1 },
        ticks: { stroke: axisColor, width: 1 },
        font: '10px ui-monospace, monospace',
        size: 40,
      },
    ],
  };
}
