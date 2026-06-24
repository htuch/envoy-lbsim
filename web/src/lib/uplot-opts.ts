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

/**
 * Build dense, axis-light uPlot options for one gauge strip: `entityCount` line
 * series over a virtual-time (seconds) x axis, no legend, hairline grid. Kept
 * pure so it is unit-testable without a canvas.
 */
export function makeTimelineOpts(
  entityCount: number,
  width: number,
  height: number,
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
  return {
    width: Math.max(width, 1),
    height: Math.max(height, 1),
    legend: { show: false },
    cursor: { y: false, points: { show: false } },
    scales: { x: { time: false } },
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
