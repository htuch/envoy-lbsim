import { describe, expect, it, vi } from 'vitest';
import {
  formatCompactTick,
  makeTimelineOpts,
  SERIES_COLORS,
  seekTimeFromPlot,
  selectionFromPlot,
  seriesColor,
  type TimelineSync,
} from './uplot-opts';

describe('formatCompactTick', () => {
  it('formats sub-thousand values as short decimals without separators', () => {
    expect(formatCompactTick(0)).toBe('0');
    expect(formatCompactTick(0.25)).toBe('0.25');
    expect(formatCompactTick(0.5)).toBe('0.5');
    expect(formatCompactTick(42)).toBe('42');
    expect(formatCompactTick(250)).toBe('250');
    expect(formatCompactTick(999)).toBe('999');
  });

  it('formats thousands with a k suffix to ~3 significant digits', () => {
    expect(formatCompactTick(1000)).toBe('1k');
    expect(formatCompactTick(1500)).toBe('1.5k');
    expect(formatCompactTick(14000)).toBe('14k');
  });

  it('formats millions with an M suffix', () => {
    expect(formatCompactTick(1.5e6)).toBe('1.5M');
    expect(formatCompactTick(2e6)).toBe('2M');
  });

  it('handles negative values symmetrically', () => {
    expect(formatCompactTick(-14000)).toBe('-14k');
    expect(formatCompactTick(-0.25)).toBe('-0.25');
  });
});

describe('seriesColor', () => {
  it('cycles the palette by index', () => {
    expect(seriesColor(0)).toBe(SERIES_COLORS[0]);
    expect(seriesColor(SERIES_COLORS.length)).toBe(SERIES_COLORS[0]);
    expect(seriesColor(SERIES_COLORS.length + 1)).toBe(SERIES_COLORS[1]);
  });
});

describe('makeTimelineOpts', () => {
  it('builds one x series plus one line series per entity', () => {
    const opts = makeTimelineOpts(3, 800, 96);
    expect(opts.series).toHaveLength(4); // x + 3 entities
    expect(opts.width).toBe(800);
    expect(opts.height).toBe(96);
    expect(opts.axes).toHaveLength(2);
  });

  it('formats y-axis ticks compactly via the values callback', () => {
    const opts = makeTimelineOpts(2, 800, 96);
    const yAxis = opts.axes?.[1];
    const values = yAxis?.values as (u: unknown, splits: number[]) => string[];
    expect(values({}, [0, 1500, 14000, 1.5e6])).toEqual(['0', '1.5k', '14k', '1.5M']);
  });

  it('clamps non-positive sizes to at least one pixel', () => {
    const opts = makeTimelineOpts(0, 0, 0);
    expect(opts.width).toBe(1);
    expect(opts.height).toBe(1);
    expect(opts.series).toHaveLength(1); // just the x series
  });

  it('wires lock-step zoom when a sync is supplied', () => {
    let window: [number, number] | null = null;
    const sync: TimelineSync = {
      getWindowSec: () => window,
      onSelectSec: vi.fn(),
    };
    const opts = makeTimelineOpts(2, 800, 96, sync);
    // Drag brushes x for capture only; it does not rescale the single plot.
    expect(opts.cursor?.drag).toEqual({ x: true, y: false, setScale: false });

    const range = opts.scales?.x?.range as (u: unknown, a: number, b: number) => [number, number];
    // No selection → fit the data extent.
    expect(range({}, 0, 10)).toEqual([0, 10]);
    // Selection set → pin to the shared window (freeze).
    window = [2, 5];
    expect(range({}, 0, 10)).toEqual([2, 5]);
    // Null data extent → a safe unit range.
    window = null;
    expect(range({}, null as unknown as number, null as unknown as number)).toEqual([0, 1]);
  });
});

describe('selectionFromPlot', () => {
  it('maps a drag region to an ordered x-window in scale units', () => {
    const u = { select: { left: 50, width: 150 }, posToVal: (p: number) => p / 10 };
    expect(selectionFromPlot(u)).toEqual([5, 20]); // 50→5, 200→20
  });

  it('orders the bounds regardless of axis direction', () => {
    const u = { select: { left: 50, width: 150 }, posToVal: (p: number) => (300 - p) / 10 };
    expect(selectionFromPlot(u)).toEqual([10, 25]); // 50→25, 200→10
  });

  it('returns null for a too-small drag', () => {
    const u = { select: { left: 0, width: 3 }, posToVal: (p: number) => p };
    expect(selectionFromPlot(u)).toBeNull();
  });
});

describe('seekTimeFromPlot', () => {
  it('maps a plain click cursor position to a virtual time in ms', () => {
    // x axis is seconds; posToVal(300) = 3s => 3000ms.
    const u = { select: { width: 0 }, cursor: { left: 300 }, posToVal: (p: number) => p / 100 };
    expect(seekTimeFromPlot(u)).toBe(3000);
  });

  it('returns null when the gesture was a brush-drag (select wider than threshold)', () => {
    const u = { select: { width: 400 }, cursor: { left: 300 }, posToVal: (p: number) => p / 100 };
    expect(seekTimeFromPlot(u)).toBeNull();
  });

  it('returns null when the cursor is off the plot', () => {
    const offPlot = { select: { width: 0 }, cursor: { left: -1 }, posToVal: (p: number) => p };
    expect(seekTimeFromPlot(offPlot)).toBeNull();
    const noCursor = { select: { width: 0 }, cursor: {}, posToVal: (p: number) => p };
    expect(seekTimeFromPlot(noCursor)).toBeNull();
  });
});
