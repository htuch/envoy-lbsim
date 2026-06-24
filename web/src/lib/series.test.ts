import { GaugeRingBuffer, type RingBufferSpec } from '@elbsim/protocol';
import { describe, expect, it } from 'vitest';
import { buildSeries } from './series';

// Two envoys; the per-entity field count is derived from the live schema so the
// test stays correct as gauge columns are appended (see protocol/snapshots.ts).
const spec: RingBufferSpec = { kind: 'envoy', entityCount: 2, capacity: 8 };

describe('buildSeries', () => {
  it('returns empty arrays for an empty ring', () => {
    const ring = GaugeRingBuffer.alloc(spec);
    const s = buildSeries(ring, 0);
    expect(s.x).toEqual([]);
    expect(s.ys).toEqual([[], []]);
  });

  it('extracts one gauge column per entity with x in seconds', () => {
    const ring = GaugeRingBuffer.alloc(spec);
    const stride = ring.stride;
    const fields = stride / spec.entityCount; // gauges per entity
    // Frame at t=1000ms: entity0 gauge0 = 10, entity1 gauge0 = 20.
    const f1 = new Float32Array(stride);
    f1[0] = 10;
    f1[fields] = 20;
    ring.push(1000, f1);
    const f2 = new Float32Array(stride);
    f2[0] = 11;
    f2[fields] = 21;
    ring.push(2000, f2);

    const s = buildSeries(ring, 0);
    expect(s.x).toEqual([1, 2]); // seconds
    expect(s.ys).toEqual([
      [10, 11],
      [20, 21],
    ]);
  });
});
