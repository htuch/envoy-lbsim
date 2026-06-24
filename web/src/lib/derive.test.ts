import {
  type EntityKind,
  GaugeRingBuffer,
  gaugeIndex,
  type RingBufferSpec,
} from '@elbsim/protocol';
import { describe, expect, it } from 'vitest';
import { goodputSeries, lossSeries, selectedSeries } from './derive';

// ---------------------------------------------------------------------------
// Helpers: build rings with known gauge values.
// ---------------------------------------------------------------------------

/** CLIENT_GAUGES: emitRate(0) inFlight(1) completed(2) failed(3) timedOut(4) */
function makeClientRing(entityCount: number, capacity: number): GaugeRingBuffer {
  return GaugeRingBuffer.alloc({ kind: 'client', entityCount, capacity });
}

/** ENVOY_GAUGES: inFlight(0) queueDepth(1) pickRate(2) rejectRate(3) ... */
function makeEnvoyRing(entityCount: number, capacity: number): GaugeRingBuffer {
  return GaugeRingBuffer.alloc({ kind: 'envoy', entityCount, capacity });
}

/** BACKEND_GAUGES: inFlight(0) queueDepth(1) utilization(2) completed(3) shed(4) ... */
function makeBackendRing(entityCount: number, capacity: number): GaugeRingBuffer {
  return GaugeRingBuffer.alloc({ kind: 'backend', entityCount, capacity });
}

/**
 * Build a client frame row for `entityCount` clients where every client has
 * the same per-entity values.
 */
function clientFrame(
  entityCount: number,
  per: {
    emitRate?: number;
    inFlight?: number;
    completed?: number;
    failed?: number;
    timedOut?: number;
  },
): Float32Array {
  const fieldCount = 5; // CLIENT_GAUGES has 5 fields
  const row = new Float32Array(entityCount * fieldCount);
  for (let e = 0; e < entityCount; e++) {
    row[e * fieldCount + 0] = per.emitRate ?? 0;
    row[e * fieldCount + 1] = per.inFlight ?? 0;
    row[e * fieldCount + 2] = per.completed ?? 0;
    row[e * fieldCount + 3] = per.failed ?? 0;
    row[e * fieldCount + 4] = per.timedOut ?? 0;
  }
  return row;
}

function envoyFrame(
  entityCount: number,
  per: { inFlight?: number; queueDepth?: number; pickRate?: number; rejectRate?: number },
): Float32Array {
  // ENVOY_GAUGES has 9 fields (inFlight queueDepth pickRate rejectRate healthyHosts panic latencyP50 latencyP90 latencyP99)
  const fieldCount = 9;
  const row = new Float32Array(entityCount * fieldCount);
  for (let e = 0; e < entityCount; e++) {
    row[e * fieldCount + 0] = per.inFlight ?? 0;
    row[e * fieldCount + 1] = per.queueDepth ?? 0;
    row[e * fieldCount + 2] = per.pickRate ?? 0;
    row[e * fieldCount + 3] = per.rejectRate ?? 0;
  }
  return row;
}

function backendFrame(
  entityCount: number,
  per: {
    inFlight?: number;
    queueDepth?: number;
    utilization?: number;
    completed?: number;
    shed?: number;
  },
): Float32Array {
  // BACKEND_GAUGES has 9 fields (inFlight queueDepth utilization completed shed health latencyP50 latencyP90 latencyP99)
  const fieldCount = 9;
  const row = new Float32Array(entityCount * fieldCount);
  for (let e = 0; e < entityCount; e++) {
    row[e * fieldCount + 0] = per.inFlight ?? 0;
    row[e * fieldCount + 1] = per.queueDepth ?? 0;
    row[e * fieldCount + 2] = per.utilization ?? 0;
    row[e * fieldCount + 3] = per.completed ?? 0;
    row[e * fieldCount + 4] = per.shed ?? 0;
  }
  return row;
}

function makeRings(
  clientCount: number,
  envoyCount: number,
  backendCount: number,
  capacity: number,
): Map<EntityKind, GaugeRingBuffer> {
  return new Map<EntityKind, GaugeRingBuffer>([
    ['client', makeClientRing(clientCount, capacity)],
    ['envoy', makeEnvoyRing(envoyCount, capacity)],
    ['backend', makeBackendRing(backendCount, capacity)],
  ]);
}

// ---------------------------------------------------------------------------
// goodputSeries
// ---------------------------------------------------------------------------

describe('goodputSeries', () => {
  it('returns empty arrays when rings have no frames', () => {
    const rings = makeRings(2, 2, 2, 8);
    const s = goodputSeries(rings);
    expect(s.x).toEqual([]);
    expect(s.y).toEqual([]);
  });

  it('returns empty arrays when a ring kind is missing from the map', () => {
    // Missing envoy and backend rings.
    const rings = new Map<EntityKind, GaugeRingBuffer>([['client', makeClientRing(1, 8)]]);
    expect(goodputSeries(rings)).toEqual({ x: [], y: [] });
  });

  it('x is frame timestamp in seconds from the client ring', () => {
    const rings = makeRings(1, 1, 1, 8);
    const cr = rings.get('client')!;
    const er = rings.get('envoy')!;
    const br = rings.get('backend')!;
    cr.push(1000, clientFrame(1, { completed: 10 }));
    er.push(1000, envoyFrame(1, {}));
    br.push(1000, backendFrame(1, {}));
    const s = goodputSeries(rings);
    expect(s.x).toEqual([1]);
  });

  it('goodput = completedSum * (1000/sampleIntervalMs) with alpha=1 (no smoothing)', () => {
    // alpha=1 means EWMA collapses to the raw value each frame.
    // sampleIntervalMs=500: rate = completed * 1000/500 = completed * 2
    const rings = makeRings(1, 1, 1, 8);
    const cr = rings.get('client')!;
    const er = rings.get('envoy')!;
    const br = rings.get('backend')!;
    // completed=8, sampleIntervalMs=500 => raw rate = 8 * 2 = 16 req/s
    cr.push(1000, clientFrame(1, { completed: 8 }));
    er.push(1000, envoyFrame(1, {}));
    br.push(1000, backendFrame(1, {}));
    const s = goodputSeries(rings, 1, 500);
    expect(s.y[0]).toBeCloseTo(16);
  });

  it('uses only completed count (not denominator ratio)', () => {
    // Losses are no longer in the goodput formula; only completedSum matters.
    const rings = makeRings(1, 1, 1, 8);
    const cr = rings.get('client')!;
    const er = rings.get('envoy')!;
    const br = rings.get('backend')!;
    // completed=6, rejectRate=2, shed=2: old ratio was 0.6; new rate = 6*1 = 6 req/s
    cr.push(1000, clientFrame(1, { completed: 6, timedOut: 0 }));
    er.push(1000, envoyFrame(1, { rejectRate: 2 }));
    br.push(1000, backendFrame(1, { shed: 2 }));
    const s = goodputSeries(rings, 1, 1000);
    expect(s.y[0]).toBeCloseTo(6);
  });

  it('sums completed across multiple clients', () => {
    // 2 clients: each completed=5 => completedSum=10; sampleIntervalMs=1000 => 10 req/s
    const rings = makeRings(2, 2, 2, 8);
    const cr = rings.get('client')!;
    const er = rings.get('envoy')!;
    const br = rings.get('backend')!;
    cr.push(1000, clientFrame(2, { completed: 5, timedOut: 0 }));
    er.push(1000, envoyFrame(2, { rejectRate: 0 }));
    br.push(1000, backendFrame(2, { shed: 0 }));
    const s = goodputSeries(rings, 1, 1000);
    expect(s.y[0]).toBeCloseTo(10);
  });

  it('no-completions frame (i>0) carries previous smoothed value', () => {
    const rings = makeRings(1, 1, 1, 8);
    const cr = rings.get('client')!;
    const er = rings.get('envoy')!;
    const br = rings.get('backend')!;
    // frame 0: completed=4, sampleIntervalMs=1000 => raw=4 req/s; with alpha=1, smoothed=4
    cr.push(1000, clientFrame(1, { completed: 4, timedOut: 4 }));
    er.push(1000, envoyFrame(1, {}));
    br.push(1000, backendFrame(1, {}));
    // frame 1: completed=0 => no completions, carry 4
    cr.push(2000, clientFrame(1, {}));
    er.push(2000, envoyFrame(1, {}));
    br.push(2000, backendFrame(1, {}));
    const s = goodputSeries(rings, 1, 1000);
    expect(s.y[0]).toBeCloseTo(4);
    expect(s.y[1]).toBeCloseTo(4); // carried forward
  });

  it('first frame with no completions gives goodput=0', () => {
    const rings = makeRings(1, 1, 1, 8);
    const cr = rings.get('client')!;
    const er = rings.get('envoy')!;
    const br = rings.get('backend')!;
    cr.push(1000, clientFrame(1, {}));
    er.push(1000, envoyFrame(1, {}));
    br.push(1000, backendFrame(1, {}));
    const s = goodputSeries(rings, 1, 1000);
    expect(s.y[0]).toBe(0);
  });

  it('applies EWMA smoothing with default alpha=0.3', () => {
    const rings = makeRings(1, 1, 1, 8);
    const cr = rings.get('client')!;
    const er = rings.get('envoy')!;
    const br = rings.get('backend')!;
    // frame 0: completed=10, sampleIntervalMs=1000 => raw=10 req/s
    // smoothed_0 = 0.3*10 + 0.7*0 = 3
    cr.push(1000, clientFrame(1, { completed: 10 }));
    er.push(1000, envoyFrame(1, {}));
    br.push(1000, backendFrame(1, {}));
    // frame 1: completed=10 => raw=10; smoothed_1 = 0.3*10 + 0.7*3 = 5.1
    cr.push(2000, clientFrame(1, { completed: 10 }));
    er.push(2000, envoyFrame(1, {}));
    br.push(2000, backendFrame(1, {}));
    const s = goodputSeries(rings, undefined, 1000);
    expect(s.y[0]).toBeCloseTo(3.0);
    expect(s.y[1]).toBeCloseTo(5.1);
  });

  it('non-negative guardrail: y is never negative', () => {
    // With valid data this should never trigger, but the guardrail keeps y >= 0.
    const rings = makeRings(1, 1, 1, 8);
    const cr = rings.get('client')!;
    const er = rings.get('envoy')!;
    const br = rings.get('backend')!;
    cr.push(1000, clientFrame(1, { completed: 100 }));
    er.push(1000, envoyFrame(1, {}));
    br.push(1000, backendFrame(1, {}));
    const s = goodputSeries(rings, 1, 1000);
    expect(s.y[0]).toBeGreaterThanOrEqual(0);
  });

  it('bounds the frame count by the shortest ring when channels are out of sync', () => {
    // The real worker pushes the three channels within one tick but not
    // atomically, so a reader can observe the client ring one frame ahead of
    // the envoy/backend rings. The series must read only shared frames and not
    // call frameAt past the shorter rings.
    const rings = makeRings(1, 1, 1, 8);
    const cr = rings.get('client')!;
    const er = rings.get('envoy')!;
    const br = rings.get('backend')!;
    cr.push(1000, clientFrame(1, { completed: 8, timedOut: 2 }));
    er.push(1000, envoyFrame(1, {}));
    br.push(1000, backendFrame(1, {}));
    // Client advances a frame before the other two channels catch up.
    cr.push(2000, clientFrame(1, { completed: 9, timedOut: 1 }));
    expect(() => goodputSeries(rings)).not.toThrow();
    expect(() => lossSeries(rings)).not.toThrow();
    expect(goodputSeries(rings).y).toHaveLength(1);
    const loss = lossSeries(rings);
    expect(loss.timeouts).toHaveLength(1);
    expect(loss.envoyRejects).toHaveLength(1);
    expect(loss.backendShed).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// lossSeries
// ---------------------------------------------------------------------------

describe('lossSeries', () => {
  it('returns empty arrays when rings have no frames', () => {
    const rings = makeRings(2, 2, 2, 8);
    const s = lossSeries(rings);
    expect(s.x).toEqual([]);
    expect(s.timeouts).toEqual([]);
    expect(s.envoyRejects).toEqual([]);
    expect(s.backendShed).toEqual([]);
  });

  it('returns empty arrays when a ring kind is missing from the map', () => {
    const rings = new Map<EntityKind, GaugeRingBuffer>([['client', makeClientRing(1, 8)]]);
    expect(lossSeries(rings)).toEqual({ x: [], timeouts: [], envoyRejects: [], backendShed: [] });
  });

  it('x is frame timestamp in seconds from client ring', () => {
    const rings = makeRings(1, 1, 1, 8);
    rings.get('client')!.push(2500, clientFrame(1, {}));
    rings.get('envoy')!.push(2500, envoyFrame(1, {}));
    rings.get('backend')!.push(2500, backendFrame(1, {}));
    expect(lossSeries(rings).x).toEqual([2.5]);
  });

  it('converts timedOut fleet sum to req/s using sampleIntervalMs', () => {
    const rings = makeRings(3, 1, 1, 8);
    // 3 clients, each timedOut=2 => sum=6; sampleIntervalMs=500 => 6*2=12 req/s
    rings.get('client')!.push(1000, clientFrame(3, { timedOut: 2 }));
    rings.get('envoy')!.push(1000, envoyFrame(1, {}));
    rings.get('backend')!.push(1000, backendFrame(1, {}));
    const s = lossSeries(rings, 500);
    expect(s.timeouts[0]).toBeCloseTo(12);
    expect(s.envoyRejects[0]).toBeCloseTo(0);
    expect(s.backendShed[0]).toBeCloseTo(0);
  });

  it('converts rejectRate fleet sum to req/s using sampleIntervalMs', () => {
    const rings = makeRings(1, 3, 1, 8);
    rings.get('client')!.push(1000, clientFrame(1, {}));
    // 3 envoys, each rejectRate=4 => sum=12; sampleIntervalMs=1000 => 12 req/s
    rings.get('envoy')!.push(1000, envoyFrame(3, { rejectRate: 4 }));
    rings.get('backend')!.push(1000, backendFrame(1, {}));
    const s = lossSeries(rings, 1000);
    expect(s.timeouts[0]).toBeCloseTo(0);
    expect(s.envoyRejects[0]).toBeCloseTo(12);
    expect(s.backendShed[0]).toBeCloseTo(0);
  });

  it('converts shed fleet sum to req/s using sampleIntervalMs', () => {
    const rings = makeRings(1, 1, 4, 8);
    rings.get('client')!.push(1000, clientFrame(1, {}));
    rings.get('envoy')!.push(1000, envoyFrame(1, {}));
    // 4 backends, each shed=3 => sum=12; sampleIntervalMs=1000 => 12 req/s
    rings.get('backend')!.push(1000, backendFrame(4, { shed: 3 }));
    const s = lossSeries(rings, 1000);
    expect(s.backendShed[0]).toBeCloseTo(12);
  });

  it('handles multiple frames correctly and converts to req/s', () => {
    const rings = makeRings(2, 1, 1, 8);
    const cr = rings.get('client')!;
    const er = rings.get('envoy')!;
    const br = rings.get('backend')!;
    // frame 0: 2 clients each timedOut=1 => sum=2; sampleIntervalMs=1000 => 2 req/s
    cr.push(1000, clientFrame(2, { timedOut: 1 }));
    er.push(1000, envoyFrame(1, {}));
    br.push(1000, backendFrame(1, {}));
    // frame 1: 2 clients each timedOut=3 => sum=6; 6 req/s
    cr.push(2000, clientFrame(2, { timedOut: 3 }));
    er.push(2000, envoyFrame(1, {}));
    br.push(2000, backendFrame(1, {}));
    const s = lossSeries(rings, 1000);
    expect(s.x).toEqual([1, 2]);
    expect(s.timeouts).toEqual([2, 6]);
  });
});

// ---------------------------------------------------------------------------
// selectedSeries
// ---------------------------------------------------------------------------

describe('selectedSeries', () => {
  it('returns empty arrays for an empty ring', () => {
    const ring = GaugeRingBuffer.alloc({ kind: 'backend', entityCount: 3, capacity: 8 });
    const s = selectedSeries(ring, 0, 1);
    expect(s.x).toEqual([]);
    expect(s.y).toEqual([]);
  });

  it('extracts the correct entity column', () => {
    const spec: RingBufferSpec = { kind: 'backend', entityCount: 3, capacity: 8 };
    const ring = GaugeRingBuffer.alloc(spec);
    const fieldCount = 9; // BACKEND_GAUGES has 9 fields
    // Three entities with distinct values for gauge index 3 (completed)
    const f1 = new Float32Array(3 * fieldCount);
    f1[0 * fieldCount + 3] = 100; // entity 0 completed
    f1[1 * fieldCount + 3] = 200; // entity 1 completed
    f1[2 * fieldCount + 3] = 300; // entity 2 completed
    ring.push(1000, f1);

    const gIdx = gaugeIndex('backend', 'completed');
    const s0 = selectedSeries(ring, gIdx, 0);
    const s1 = selectedSeries(ring, gIdx, 1);
    const s2 = selectedSeries(ring, gIdx, 2);
    expect(s0.y[0]).toBeCloseTo(100);
    expect(s1.y[0]).toBeCloseTo(200);
    expect(s2.y[0]).toBeCloseTo(300);
  });

  it('x is in seconds', () => {
    const ring = GaugeRingBuffer.alloc({ kind: 'client', entityCount: 2, capacity: 8 });
    ring.push(3500, clientFrame(2, { completed: 5 }));
    const s = selectedSeries(ring, gaugeIndex('client', 'completed'), 0);
    expect(s.x).toEqual([3.5]);
  });

  it('entity 1 matches the second entity column across frames', () => {
    const ring = GaugeRingBuffer.alloc({ kind: 'envoy', entityCount: 2, capacity: 8 });
    const fieldCount = 9; // ENVOY_GAUGES has 9 fields
    const f1 = new Float32Array(2 * fieldCount);
    f1[0 * fieldCount + 3] = 10; // entity 0 rejectRate
    f1[1 * fieldCount + 3] = 20; // entity 1 rejectRate
    ring.push(1000, f1);
    const f2 = new Float32Array(2 * fieldCount);
    f2[0 * fieldCount + 3] = 11;
    f2[1 * fieldCount + 3] = 21;
    ring.push(2000, f2);

    const gIdx = gaugeIndex('envoy', 'rejectRate');
    const s = selectedSeries(ring, gIdx, 1);
    expect(s.x).toEqual([1, 2]);
    expect(s.y).toEqual([20, 21]);
  });

  it('out-of-range entity returns zeroed y array gracefully', () => {
    const ring = GaugeRingBuffer.alloc({ kind: 'backend', entityCount: 2, capacity: 8 });
    ring.push(1000, backendFrame(2, { completed: 5 }));
    ring.push(2000, backendFrame(2, { completed: 7 }));
    // entity index 99 is way out of range
    const s = selectedSeries(ring, gaugeIndex('backend', 'completed'), 99);
    expect(s.x).toEqual([1, 2]);
    expect(s.y).toEqual([0, 0]);
  });

  it('negative entity index returns zeroed y array gracefully', () => {
    const ring = GaugeRingBuffer.alloc({ kind: 'backend', entityCount: 2, capacity: 8 });
    ring.push(1000, backendFrame(2, { completed: 5 }));
    const s = selectedSeries(ring, gaugeIndex('backend', 'completed'), -1);
    expect(s.x).toEqual([1]);
    expect(s.y).toEqual([0]);
  });
});
