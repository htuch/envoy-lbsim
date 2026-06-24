import { defaultSimConfig, parseSimConfig, type SimConfig } from '@elbsim/config';
import {
  BACKEND_GAUGES,
  CLIENT_GAUGES,
  ENVOY_GAUGES,
  type EntityKind,
  GaugeRingBuffer,
  gaugeIndex,
  type RingBufferSpec,
} from '@elbsim/protocol';
import { Prng } from '@elbsim/sim-core';
import { describe, expect, it } from 'vitest';
import { makeEdges } from './topology-edges';
import { frameToTopologySnapshot } from './topology-snapshot';

function configWith(overrides: Record<string, unknown>): SimConfig {
  return parseSimConfig({ ...defaultSimConfig(), ...overrides });
}

/** Build a ring with one pushed frame. All values default to 0 except what
 * `setValues` patches by gauge name. */
function makeRing(
  kind: EntityKind,
  entityCount: number,
  t: number,
  setValues: Record<string, number[]>,
): GaugeRingBuffer {
  const spec: RingBufferSpec = { kind, entityCount, capacity: 8 };
  const ring = GaugeRingBuffer.alloc(spec);
  const gaugeNames =
    kind === 'client' ? CLIENT_GAUGES : kind === 'envoy' ? ENVOY_GAUGES : BACKEND_GAUGES;
  const stride = entityCount * gaugeNames.length;
  const values = new Float32Array(stride);
  for (const [name, perEntity] of Object.entries(setValues)) {
    const col = gaugeIndex(kind, name);
    for (let e = 0; e < entityCount; e++) {
      values[e * gaugeNames.length + col] = perEntity[e] ?? 0;
    }
  }
  ring.push(t, values);
  return ring;
}

describe('frameToTopologySnapshot', () => {
  it('maps envoy inFlight and panic gauges to node fields', () => {
    const config = configWith({
      clients: {
        count: 2,
        arrival: { kind: 'poisson', ratePerSec: 10 },
        requestKey: { kind: 'uniform', n: 100 },
        lb: { kind: 'round_robin' },
      },
      envoys: {
        count: 2,
        policy: { kind: 'maglev' },
        queue: { maxConcurrentRequests: 100, queueCapacity: 50 },
      },
      backends: {
        count: 2,
        defaults: { capacity: 32, latency: { kind: 'constant', value: 5 }, queueSize: 16 },
      },
    });

    const clientRing = makeRing('client', 2, 100, { inFlight: [2, 3] });
    const envoyRing = makeRing('envoy', 2, 100, {
      inFlight: [40, 80],
      queueDepth: [5, 10],
      panic: [0, 1],
    });
    const backendRing = makeRing('backend', 2, 100, {
      inFlight: [10, 20],
      queueDepth: [3, 7],
      utilization: [0.3, 0.6],
      health: [0, 1],
    });

    const rings = new Map<EntityKind, GaugeRingBuffer>([
      ['client', clientRing],
      ['envoy', envoyRing],
      ['backend', backendRing],
    ]);

    const snap = frameToTopologySnapshot(config, rings, config.seed);

    // Timestamp comes from envoy ring's latest frame.
    expect(snap.t).toBe(100);

    // Clients: inFlight from gauge, utilization = min(1, inFlight/4).
    expect(snap.clients[0]!.inFlight).toBe(2);
    expect(snap.clients[0]!.utilization).toBeCloseTo(Math.min(1, 2 / 4));
    expect(snap.clients[1]!.inFlight).toBe(3);
    expect(snap.clients[1]!.utilization).toBeCloseTo(Math.min(1, 3 / 4));
    expect(snap.clients[0]!.queueDepth).toBe(0);
    expect(snap.clients[0]!.queueCapacity).toBe(0);
    expect(snap.clients[0]!.health).toBe(0);
    expect(snap.clients[0]!.panic).toBe(false);

    // Envoys: inFlight, queueDepth from gauges; utilization = inFlight / maxConcurrentRequests.
    expect(snap.envoys[0]!.inFlight).toBe(40);
    expect(snap.envoys[0]!.queueDepth).toBe(5);
    expect(snap.envoys[0]!.utilization).toBeCloseTo(40 / 100);
    expect(snap.envoys[0]!.queueCapacity).toBe(50);
    expect(snap.envoys[0]!.panic).toBe(false); // panic gauge 0 -> false
    expect(snap.envoys[1]!.inFlight).toBe(80);
    expect(snap.envoys[1]!.queueDepth).toBe(10);
    expect(snap.envoys[1]!.utilization).toBeCloseTo(80 / 100);
    expect(snap.envoys[1]!.panic).toBe(true); // panic gauge 1 -> true (> 0.5)
    expect(snap.envoys[0]!.health).toBe(0);

    // Backends: inFlight, queueDepth from gauges; utilization from gauge; health ordinal.
    expect(snap.backends[0]!.inFlight).toBe(10);
    expect(snap.backends[0]!.queueDepth).toBe(3);
    expect(snap.backends[0]!.utilization).toBeCloseTo(0.3);
    expect(snap.backends[0]!.queueCapacity).toBe(16); // from config queueSize
    expect(snap.backends[0]!.health).toBe(0);
    expect(snap.backends[0]!.panic).toBe(false);
    expect(snap.backends[1]!.inFlight).toBe(20);
    expect(snap.backends[1]!.queueDepth).toBe(7);
    expect(snap.backends[1]!.utilization).toBeCloseTo(0.6);
    expect(snap.backends[1]!.health).toBe(1);
  });

  it('produces correct labels, kinds, and indices', () => {
    const config = configWith({
      clients: {
        count: 2,
        arrival: { kind: 'poisson', ratePerSec: 10 },
        requestKey: { kind: 'uniform', n: 100 },
        lb: { kind: 'round_robin' },
      },
      envoys: {
        count: 2,
        policy: { kind: 'maglev' },
        queue: { maxConcurrentRequests: 16, queueCapacity: 8 },
      },
      backends: {
        count: 2,
        defaults: { capacity: 8, latency: { kind: 'constant', value: 5 } },
      },
    });

    const rings = new Map<EntityKind, GaugeRingBuffer>([
      ['client', makeRing('client', 2, 50, {})],
      ['envoy', makeRing('envoy', 2, 50, {})],
      ['backend', makeRing('backend', 2, 50, {})],
    ]);

    const snap = frameToTopologySnapshot(config, rings);
    expect(snap.clients[0]).toMatchObject({ kind: 'client', index: 0, label: 'c0' });
    expect(snap.clients[1]).toMatchObject({ kind: 'client', index: 1, label: 'c1' });
    expect(snap.envoys[0]).toMatchObject({ kind: 'envoy', index: 0, label: 'e0' });
    expect(snap.backends[1]).toMatchObject({ kind: 'backend', index: 1, label: 'b1' });
  });

  it('reads locality from config for clients and envoys', () => {
    const config = configWith({
      clients: {
        count: 1,
        arrival: { kind: 'poisson', ratePerSec: 10 },
        requestKey: { kind: 'uniform', n: 100 },
        lb: { kind: 'round_robin' },
        locality: { region: 'us-west', zone: 'z9' },
      },
      envoys: {
        count: 1,
        policy: { kind: 'maglev' },
        queue: { maxConcurrentRequests: 16 },
        locality: { region: 'us-east', zone: 'z3' },
      },
      backends: {
        count: 1,
        defaults: { capacity: 8, latency: { kind: 'constant', value: 5 } },
      },
    });

    const rings = new Map<EntityKind, GaugeRingBuffer>([
      ['client', makeRing('client', 1, 10, {})],
      ['envoy', makeRing('envoy', 1, 10, {})],
      ['backend', makeRing('backend', 1, 10, {})],
    ]);

    const snap = frameToTopologySnapshot(config, rings);
    expect(snap.clients[0]).toMatchObject({ region: 'us-west', zone: 'z9' });
    expect(snap.envoys[0]).toMatchObject({ region: 'us-east', zone: 'z3' });
  });

  it('reads locality from resolveBackend for backends', () => {
    const config = configWith({
      clients: {
        count: 1,
        arrival: { kind: 'poisson', ratePerSec: 10 },
        requestKey: { kind: 'uniform', n: 100 },
        lb: { kind: 'round_robin' },
      },
      envoys: { count: 1, policy: { kind: 'maglev' }, queue: { maxConcurrentRequests: 16 } },
      backends: {
        count: 2,
        defaults: { capacity: 8, latency: { kind: 'constant', value: 5 } },
        overrides: { '1': { locality: { region: 'ap-south', zone: 'z7' } } },
      },
    });

    const rings = new Map<EntityKind, GaugeRingBuffer>([
      ['client', makeRing('client', 1, 10, {})],
      ['envoy', makeRing('envoy', 1, 10, {})],
      ['backend', makeRing('backend', 2, 10, {})],
    ]);

    const snap = frameToTopologySnapshot(config, rings);
    expect(snap.backends[0]).toMatchObject({ region: 'r1', zone: 'z1' });
    expect(snap.backends[1]).toMatchObject({ region: 'ap-south', zone: 'z7' });
  });

  it('edges match makeEdges length and are deterministic', () => {
    const config = configWith({
      clients: {
        count: 3,
        arrival: { kind: 'poisson', ratePerSec: 10 },
        requestKey: { kind: 'uniform', n: 100 },
        lb: { kind: 'round_robin' },
      },
      envoys: { count: 2, policy: { kind: 'maglev' }, queue: { maxConcurrentRequests: 16 } },
      backends: {
        count: 4,
        defaults: { capacity: 8, latency: { kind: 'constant', value: 5 } },
      },
    });

    const rings = new Map<EntityKind, GaugeRingBuffer>([
      ['client', makeRing('client', 3, 0, {})],
      ['envoy', makeRing('envoy', 2, 0, {})],
      ['backend', makeRing('backend', 4, 0, {})],
    ]);

    const snap1 = frameToTopologySnapshot(config, rings, config.seed);
    const snap2 = frameToTopologySnapshot(config, rings, config.seed);
    const expected = makeEdges(config, new Prng(config.seed));
    expect(snap1.edges).toHaveLength(expected.length);
    expect(snap1.edges).toEqual(snap2.edges);
  });

  it('uses envoy ring timestamp for t', () => {
    const config = configWith({
      clients: {
        count: 1,
        arrival: { kind: 'poisson', ratePerSec: 10 },
        requestKey: { kind: 'uniform', n: 100 },
        lb: { kind: 'round_robin' },
      },
      envoys: { count: 1, policy: { kind: 'maglev' }, queue: { maxConcurrentRequests: 16 } },
      backends: {
        count: 1,
        defaults: { capacity: 8, latency: { kind: 'constant', value: 5 } },
      },
    });

    const rings = new Map<EntityKind, GaugeRingBuffer>([
      ['client', makeRing('client', 1, 999, {})],
      ['envoy', makeRing('envoy', 1, 12345, {})],
      ['backend', makeRing('backend', 1, 999, {})],
    ]);

    const snap = frameToTopologySnapshot(config, rings);
    expect(snap.t).toBe(12345);
  });

  it('returns zeroed-but-valid nodes when rings are empty', () => {
    const config = configWith({
      clients: {
        count: 2,
        arrival: { kind: 'poisson', ratePerSec: 10 },
        requestKey: { kind: 'uniform', n: 100 },
        lb: { kind: 'round_robin' },
      },
      envoys: { count: 2, policy: { kind: 'maglev' }, queue: { maxConcurrentRequests: 16 } },
      backends: {
        count: 2,
        defaults: { capacity: 8, latency: { kind: 'constant', value: 5 } },
      },
    });

    // Alloc rings but never push anything.
    const emptyRings = new Map<EntityKind, GaugeRingBuffer>([
      ['client', GaugeRingBuffer.alloc({ kind: 'client', entityCount: 2, capacity: 8 })],
      ['envoy', GaugeRingBuffer.alloc({ kind: 'envoy', entityCount: 2, capacity: 8 })],
      ['backend', GaugeRingBuffer.alloc({ kind: 'backend', entityCount: 2, capacity: 8 })],
    ]);

    const snap = frameToTopologySnapshot(config, emptyRings);
    expect(snap.t).toBe(0);
    expect(snap.clients).toHaveLength(2);
    expect(snap.envoys).toHaveLength(2);
    expect(snap.backends).toHaveLength(2);
    for (const node of [...snap.clients, ...snap.envoys, ...snap.backends]) {
      expect(node.inFlight).toBe(0);
      expect(node.utilization).toBe(0);
      expect(node.queueDepth).toBe(0);
      expect(node.health).toBe(0);
      expect(node.panic).toBe(false);
    }
  });

  it('handles missing rings (undefined) as empty', () => {
    const config = configWith({
      clients: {
        count: 1,
        arrival: { kind: 'poisson', ratePerSec: 10 },
        requestKey: { kind: 'uniform', n: 100 },
        lb: { kind: 'round_robin' },
      },
      envoys: { count: 1, policy: { kind: 'maglev' }, queue: { maxConcurrentRequests: 16 } },
      backends: {
        count: 1,
        defaults: { capacity: 8, latency: { kind: 'constant', value: 5 } },
      },
    });

    // Pass a completely empty map.
    const snap = frameToTopologySnapshot(config, new Map());
    expect(snap.t).toBe(0);
    expect(snap.clients).toHaveLength(1);
    expect(snap.envoys).toHaveLength(1);
    expect(snap.backends).toHaveLength(1);
    for (const node of [...snap.clients, ...snap.envoys, ...snap.backends]) {
      expect(node.inFlight).toBe(0);
      expect(node.panic).toBe(false);
    }
  });

  it('clamps health to [0,3] for backend health gauge values', () => {
    const config = configWith({
      clients: {
        count: 1,
        arrival: { kind: 'poisson', ratePerSec: 10 },
        requestKey: { kind: 'uniform', n: 100 },
        lb: { kind: 'round_robin' },
      },
      envoys: { count: 1, policy: { kind: 'maglev' }, queue: { maxConcurrentRequests: 16 } },
      backends: {
        count: 3,
        defaults: { capacity: 8, latency: { kind: 'constant', value: 5 } },
      },
    });

    // health values: -1 (below 0), 2 (in-range), 5 (above 3).
    const rings = new Map<EntityKind, GaugeRingBuffer>([
      ['client', makeRing('client', 1, 0, {})],
      ['envoy', makeRing('envoy', 1, 0, {})],
      ['backend', makeRing('backend', 3, 0, { health: [-1, 2, 5] })],
    ]);

    const snap = frameToTopologySnapshot(config, rings);
    expect(snap.backends[0]!.health).toBe(0); // clamped from -1
    expect(snap.backends[1]!.health).toBe(2);
    expect(snap.backends[2]!.health).toBe(3); // clamped from 5
  });

  it('clamps utilization to [0,1] for envoys over maxConcurrentRequests', () => {
    const config = configWith({
      clients: {
        count: 1,
        arrival: { kind: 'poisson', ratePerSec: 10 },
        requestKey: { kind: 'uniform', n: 100 },
        lb: { kind: 'round_robin' },
      },
      envoys: {
        count: 1,
        policy: { kind: 'maglev' },
        queue: { maxConcurrentRequests: 10, queueCapacity: 5 },
      },
      backends: {
        count: 1,
        defaults: { capacity: 8, latency: { kind: 'constant', value: 5 } },
      },
    });

    // inFlight = 15 (> maxConcurrentRequests 10); utilization should be clamped to 1.
    const rings = new Map<EntityKind, GaugeRingBuffer>([
      ['client', makeRing('client', 1, 0, {})],
      ['envoy', makeRing('envoy', 1, 0, { inFlight: [15] })],
      ['backend', makeRing('backend', 1, 0, {})],
    ]);

    const snap = frameToTopologySnapshot(config, rings);
    expect(snap.envoys[0]!.utilization).toBe(1);
  });
});
