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

  it('goodput = completed / (completed + timedOut + drops) with alpha=1 (no smoothing)', () => {
    // alpha=1 means EWMA collapses to the raw value each frame.
    const rings = makeRings(1, 1, 1, 8);
    const cr = rings.get('client')!;
    const er = rings.get('envoy')!;
    const br = rings.get('backend')!;
    // completed=8, timedOut=2, rejectRate=0, shed=0  => raw = 8/10 = 0.8
    cr.push(1000, clientFrame(1, { completed: 8, timedOut: 2 }));
    er.push(1000, envoyFrame(1, { rejectRate: 0 }));
    br.push(1000, backendFrame(1, { shed: 0 }));
    const s = goodputSeries(rings, 1);
    expect(s.y[0]).toBeCloseTo(0.8);
  });

  it('includes envoy rejectRate and backend shed in the denominator', () => {
    const rings = makeRings(1, 1, 1, 8);
    const cr = rings.get('client')!;
    const er = rings.get('envoy')!;
    const br = rings.get('backend')!;
    // completed=6, timedOut=0, rejectRate=2, shed=2 => raw = 6/(6+0+2+2) = 0.6
    cr.push(1000, clientFrame(1, { completed: 6, timedOut: 0 }));
    er.push(1000, envoyFrame(1, { rejectRate: 2 }));
    br.push(1000, backendFrame(1, { shed: 2 }));
    const s = goodputSeries(rings, 1);
    expect(s.y[0]).toBeCloseTo(0.6);
  });

  it('sums across multiple entities of each kind', () => {
    // 2 clients: each completed=5, timedOut=0. 2 envoys: rejectRate=0. 2 backends: shed=0.
    // raw = 10/10 = 1.0
    const rings = makeRings(2, 2, 2, 8);
    const cr = rings.get('client')!;
    const er = rings.get('envoy')!;
    const br = rings.get('backend')!;
    cr.push(1000, clientFrame(2, { completed: 5, timedOut: 0 }));
    er.push(1000, envoyFrame(2, { rejectRate: 0 }));
    br.push(1000, backendFrame(2, { shed: 0 }));
    const s = goodputSeries(rings, 1);
    expect(s.y[0]).toBeCloseTo(1.0);
  });

  it('no-traffic frame (denominator=0) carries previous smoothed value', () => {
    const rings = makeRings(1, 1, 1, 8);
    const cr = rings.get('client')!;
    const er = rings.get('envoy')!;
    const br = rings.get('backend')!;
    // frame 0: completed=4, timedOut=4 => raw=0.5; with alpha=1, smoothed=0.5
    cr.push(1000, clientFrame(1, { completed: 4, timedOut: 4 }));
    er.push(1000, envoyFrame(1, {}));
    br.push(1000, backendFrame(1, {}));
    // frame 1: all zeros => no traffic, carry 0.5
    cr.push(2000, clientFrame(1, {}));
    er.push(2000, envoyFrame(1, {}));
    br.push(2000, backendFrame(1, {}));
    const s = goodputSeries(rings, 1);
    expect(s.y[0]).toBeCloseTo(0.5);
    expect(s.y[1]).toBeCloseTo(0.5); // carried forward
  });

  it('first frame with no traffic gives goodput=1', () => {
    const rings = makeRings(1, 1, 1, 8);
    const cr = rings.get('client')!;
    const er = rings.get('envoy')!;
    const br = rings.get('backend')!;
    cr.push(1000, clientFrame(1, {}));
    er.push(1000, envoyFrame(1, {}));
    br.push(1000, backendFrame(1, {}));
    const s = goodputSeries(rings, 1);
    expect(s.y[0]).toBe(1);
  });

  it('applies EWMA smoothing with default alpha=0.3', () => {
    const rings = makeRings(1, 1, 1, 8);
    const cr = rings.get('client')!;
    const er = rings.get('envoy')!;
    const br = rings.get('backend')!;
    // frame 0: raw=1.0; with default alpha, smoothed_0 = 1.0
    cr.push(1000, clientFrame(1, { completed: 10 }));
    er.push(1000, envoyFrame(1, {}));
    br.push(1000, backendFrame(1, {}));
    // frame 1: raw=0.0 (all timeouts); smoothed_1 = 0.3*0 + 0.7*1 = 0.7
    cr.push(2000, clientFrame(1, { timedOut: 10 }));
    er.push(2000, envoyFrame(1, {}));
    br.push(2000, backendFrame(1, {}));
    const s = goodputSeries(rings);
    expect(s.y[0]).toBeCloseTo(1.0);
    expect(s.y[1]).toBeCloseTo(0.7);
  });

  it('clamps values to [0,1]', () => {
    // This is mainly a guardrail; with valid data this should never trigger.
    // We verify the clamp by checking that 1.0 is never exceeded.
    const rings = makeRings(1, 1, 1, 8);
    const cr = rings.get('client')!;
    const er = rings.get('envoy')!;
    const br = rings.get('backend')!;
    cr.push(1000, clientFrame(1, { completed: 100 }));
    er.push(1000, envoyFrame(1, {}));
    br.push(1000, backendFrame(1, {}));
    const s = goodputSeries(rings, 1);
    expect(s.y[0]).toBeLessThanOrEqual(1);
    expect(s.y[0]).toBeGreaterThanOrEqual(0);
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

  it('sums timedOut across all clients per frame', () => {
    const rings = makeRings(3, 1, 1, 8);
    // 3 clients, each timedOut=2 => total timedOut=6
    rings.get('client')!.push(1000, clientFrame(3, { timedOut: 2 }));
    rings.get('envoy')!.push(1000, envoyFrame(1, {}));
    rings.get('backend')!.push(1000, backendFrame(1, {}));
    const s = lossSeries(rings);
    expect(s.timeouts[0]).toBeCloseTo(6);
    expect(s.envoyRejects[0]).toBeCloseTo(0);
    expect(s.backendShed[0]).toBeCloseTo(0);
  });

  it('sums rejectRate across all envoys per frame', () => {
    const rings = makeRings(1, 3, 1, 8);
    rings.get('client')!.push(1000, clientFrame(1, {}));
    // 3 envoys, each rejectRate=4 => total=12
    rings.get('envoy')!.push(1000, envoyFrame(3, { rejectRate: 4 }));
    rings.get('backend')!.push(1000, backendFrame(1, {}));
    const s = lossSeries(rings);
    expect(s.timeouts[0]).toBeCloseTo(0);
    expect(s.envoyRejects[0]).toBeCloseTo(12);
    expect(s.backendShed[0]).toBeCloseTo(0);
  });

  it('sums shed across all backends per frame', () => {
    const rings = makeRings(1, 1, 4, 8);
    rings.get('client')!.push(1000, clientFrame(1, {}));
    rings.get('envoy')!.push(1000, envoyFrame(1, {}));
    // 4 backends, each shed=3 => total=12
    rings.get('backend')!.push(1000, backendFrame(4, { shed: 3 }));
    const s = lossSeries(rings);
    expect(s.backendShed[0]).toBeCloseTo(12);
  });

  it('handles multiple frames correctly', () => {
    const rings = makeRings(2, 1, 1, 8);
    const cr = rings.get('client')!;
    const er = rings.get('envoy')!;
    const br = rings.get('backend')!;
    // frame 0: 2 clients each timedOut=1 => total=2
    cr.push(1000, clientFrame(2, { timedOut: 1 }));
    er.push(1000, envoyFrame(1, {}));
    br.push(1000, backendFrame(1, {}));
    // frame 1: 2 clients each timedOut=3 => total=6
    cr.push(2000, clientFrame(2, { timedOut: 3 }));
    er.push(2000, envoyFrame(1, {}));
    br.push(2000, backendFrame(1, {}));
    const s = lossSeries(rings);
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
