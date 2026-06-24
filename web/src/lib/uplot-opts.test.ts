import { describe, expect, it } from 'vitest';
import { makeTimelineOpts, SERIES_COLORS, seriesColor } from './uplot-opts';

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

  it('clamps non-positive sizes to at least one pixel', () => {
    const opts = makeTimelineOpts(0, 0, 0);
    expect(opts.width).toBe(1);
    expect(opts.height).toBe(1);
    expect(opts.series).toHaveLength(1); // just the x series
  });
});
