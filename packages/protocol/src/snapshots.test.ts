import { describe, expect, it } from 'vitest';
import {
  BACKEND_GAUGES,
  ENVOY_GAUGES,
  frameStride,
  GaugeRingBuffer,
  gaugeFields,
  gaugeIndex,
  type RingBufferSpec,
  ringByteLengths,
} from './snapshots';

const spec: RingBufferSpec = { kind: 'backend', entityCount: 3, capacity: 4 };

describe('gauge columns', () => {
  it('exposes ordered fields per entity kind', () => {
    expect(gaugeFields('envoy')).toEqual(ENVOY_GAUGES);
    expect(gaugeFields('backend')).toEqual(BACKEND_GAUGES);
  });

  it('resolves a gauge column index', () => {
    expect(gaugeIndex('backend', 'utilization')).toBe(BACKEND_GAUGES.indexOf('utilization'));
  });

  it('throws on an unknown gauge', () => {
    expect(() => gaugeIndex('backend', 'nope')).toThrow(/unknown backend gauge/);
  });
});

describe('ring sizing', () => {
  it('computes the frame stride and byte lengths', () => {
    expect(frameStride(spec)).toBe(3 * BACKEND_GAUGES.length);
    const bytes = ringByteLengths(spec);
    expect(bytes.control).toBe(8);
    expect(bytes.time).toBe(4 * 8);
    expect(bytes.data).toBe(4 * frameStride(spec) * 4);
  });
});

describe('GaugeRingBuffer', () => {
  function frame(fill: number): Float32Array {
    return new Float32Array(frameStride(spec)).fill(fill);
  }

  it('starts empty', () => {
    const rb = GaugeRingBuffer.alloc(spec);
    expect(rb.size()).toBe(0);
    expect(rb.latest()).toBeUndefined();
  });

  it('retains frames in chronological order and reports the latest', () => {
    const rb = GaugeRingBuffer.alloc(spec);
    rb.push(10, frame(1));
    rb.push(20, frame(2));
    expect(rb.size()).toBe(2);
    expect(rb.frameAt(0).t).toBe(10);
    expect(rb.frameAt(1).t).toBe(20);
    expect(rb.latest()?.t).toBe(20);
    expect(Array.from(rb.frameAt(1).values)).toEqual(Array.from(frame(2)));
  });

  it('wraps when capacity is exceeded, keeping the newest frames', () => {
    const rb = GaugeRingBuffer.alloc(spec);
    for (let i = 1; i <= 6; i++) rb.push(i * 10, frame(i));
    expect(rb.size()).toBe(spec.capacity);
    // Oldest retained is frame 3 (i=3 -> t=30) after two wraps.
    expect(rb.frameAt(0).t).toBe(30);
    expect(rb.latest()?.t).toBe(60);
  });

  it('rejects a wrong-sized frame and out-of-range reads', () => {
    const rb = GaugeRingBuffer.alloc(spec);
    expect(() => rb.push(0, new Float32Array(1))).toThrow(/frame must have/);
    expect(() => rb.frameAt(0)).toThrow(/out of range/);
  });

  it('validates backing array sizes', () => {
    const ok = () => ({
      c: new Int32Array(2),
      t: new Float64Array(spec.capacity),
      d: new Float32Array(spec.capacity * frameStride(spec)),
    });
    expect(() => new GaugeRingBuffer(spec, new Int32Array(1), ok().t, ok().d)).toThrow(
      /control array too small/,
    );
    expect(() => new GaugeRingBuffer(spec, ok().c, new Float64Array(1), ok().d)).toThrow(
      /time array too small/,
    );
    expect(() => new GaugeRingBuffer(spec, ok().c, ok().t, new Float32Array(1))).toThrow(
      /data array too small/,
    );
  });
});
