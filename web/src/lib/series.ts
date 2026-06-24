import type { GaugeRingBuffer } from '@elbsim/protocol';

/** uPlot-shaped series data: a shared x axis plus one y array per entity. */
export interface Series {
  /** Frame timestamps in seconds (uPlot's x is time-like). */
  x: number[];
  /** One y array per entity, aligned to {@link Series.x}. */
  ys: number[][];
}

/**
 * Extract one gauge column across every retained frame of a ring, as uPlot data.
 * One y series per entity of the ring's kind. Pure and synchronous: the timeline
 * render loop calls this off the shared buffer each frame the data changes.
 */
export function buildSeries(ring: GaugeRingBuffer, gaugeIndex: number): Series {
  const n = ring.size();
  const entityCount = ring.spec.entityCount;
  const fieldCount = ring.stride / entityCount;
  const x = new Array<number>(n);
  const ys: number[][] = Array.from({ length: entityCount }, () => new Array<number>(n));
  for (let i = 0; i < n; i++) {
    const frame = ring.frameAt(i);
    x[i] = frame.t / 1000;
    for (let e = 0; e < entityCount; e++) {
      // `ys[e]` is allocated for every e in range above; the assertion satisfies
      // noUncheckedIndexedAccess without a dead branch.
      ys[e]![i] = frame.values[e * fieldCount + gaugeIndex] as number;
    }
  }
  return { x, ys };
}
