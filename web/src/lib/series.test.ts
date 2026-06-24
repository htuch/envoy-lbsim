import { GaugeRingBuffer, type RingBufferSpec } from '@elbsim/protocol';
import { describe, expect, it } from 'vitest';
import { buildSeries } from './series';

// Two envoys, the standard six envoy gauges per frame.
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
    const stride = ring.stride; // 2 entities * 6 gauges = 12
    // Frame at t=1000ms: entity0 gauge0 = 10, entity1 gauge0 = 20.
    const f1 = new Float32Array(stride);
    f1[0] = 10;
    f1[6] = 20;
    ring.push(1000, f1);
    const f2 = new Float32Array(stride);
    f2[0] = 11;
    f2[6] = 21;
    ring.push(2000, f2);

    const s = buildSeries(ring, 0);
    expect(s.x).toEqual([1, 2]); // seconds
    expect(s.ys).toEqual([
      [10, 11],
      [20, 21],
    ]);
  });
});
