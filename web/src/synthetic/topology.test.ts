import { defaultSimConfig, parseSimConfig, type SimConfig } from '@elbsim/config';
import { describe, expect, it } from 'vitest';
import { makeTopologySnapshot } from './topology';

function configWith(overrides: Record<string, unknown>): SimConfig {
  return parseSimConfig({ ...defaultSimConfig(), ...overrides });
}

describe('makeTopologySnapshot', () => {
  it('is deterministic for the same (config, t, seed)', () => {
    const config = defaultSimConfig();
    expect(makeTopologySnapshot(config, 1000)).toEqual(makeTopologySnapshot(config, 1000));
  });

  it('produces one node per configured entity', () => {
    const config = defaultSimConfig();
    const snap = makeTopologySnapshot(config, 0);
    expect(snap.clients).toHaveLength(config.clients.count);
    expect(snap.envoys).toHaveLength(config.envoys.count);
    expect(snap.backends).toHaveLength(config.backends.count);
  });

  it('keeps utilization within [0,1] and queue depth within capacity', () => {
    const snap = makeTopologySnapshot(defaultSimConfig(), 500);
    for (const node of [...snap.clients, ...snap.envoys, ...snap.backends]) {
      expect(node.utilization).toBeGreaterThanOrEqual(0);
      expect(node.utilization).toBeLessThanOrEqual(1);
      expect(node.queueDepth).toBeLessThanOrEqual(node.queueCapacity);
    }
  });

  it('applies sparse per-backend capacity overrides', () => {
    const config = configWith({
      backends: {
        count: 4,
        defaults: { capacity: 32, latency: { kind: 'constant', value: 5 }, queueSize: 8 },
        overrides: { '2': { capacity: 1 } },
      },
    });
    // With capacity 1, in-flight can never exceed 1.
    const snap = makeTopologySnapshot(config, 0);
    expect(snap.backends[2]!.inFlight).toBeLessThanOrEqual(1);
  });

  it('routes each client to every envoy under round_robin', () => {
    const config = configWith({
      clients: {
        count: 3,
        arrival: { kind: 'poisson', ratePerSec: 10 },
        requestKey: { kind: 'uniform', n: 100 },
        lb: { kind: 'round_robin' },
      },
      envoys: { count: 2, policy: { kind: 'maglev' }, queue: { maxConcurrentRequests: 16 } },
    });
    const snap = makeTopologySnapshot(config, 0);
    const clientEdges = snap.edges.filter((e) => e.fromKind === 'client');
    expect(clientEdges).toHaveLength(3 * 2);
  });

  it('routes each client to a single sticky envoy under hash', () => {
    const config = configWith({
      clients: {
        count: 4,
        arrival: { kind: 'poisson', ratePerSec: 10 },
        requestKey: { kind: 'uniform', n: 100 },
        lb: { kind: 'hash' },
      },
      envoys: { count: 3, policy: { kind: 'maglev' }, queue: { maxConcurrentRequests: 16 } },
    });
    const snap = makeTopologySnapshot(config, 0);
    const clientEdges = snap.edges.filter((e) => e.fromKind === 'client');
    expect(clientEdges).toHaveLength(4);
    // Client 0 -> envoy 0, client 1 -> envoy 1, etc. (index % envoyCount).
    expect(clientEdges.find((e) => e.fromIndex === 3)!.toIndex).toBe(0);
  });

  it('routes each client to subsetSize envoys under subset', () => {
    const config = configWith({
      clients: {
        count: 5,
        arrival: { kind: 'poisson', ratePerSec: 10 },
        requestKey: { kind: 'uniform', n: 100 },
        lb: { kind: 'subset', subsetSize: 2 },
      },
      envoys: { count: 4, policy: { kind: 'maglev' }, queue: { maxConcurrentRequests: 16 } },
    });
    const snap = makeTopologySnapshot(config, 0);
    for (let c = 0; c < 5; c++) {
      const targets = snap.edges.filter((e) => e.fromKind === 'client' && e.fromIndex === c);
      expect(targets).toHaveLength(2);
    }
  });

  it('routes each client to resolvedSetSize envoys under dns_approx', () => {
    const config = configWith({
      clients: {
        count: 4,
        arrival: { kind: 'poisson', ratePerSec: 10 },
        requestKey: { kind: 'uniform', n: 100 },
        lb: { kind: 'dns_approx', refreshMs: 1000, resolvedSetSize: 2 },
      },
      envoys: { count: 4, policy: { kind: 'maglev' }, queue: { maxConcurrentRequests: 16 } },
    });
    const snap = makeTopologySnapshot(config, 0);
    for (let c = 0; c < 4; c++) {
      const targets = snap.edges.filter((e) => e.fromKind === 'client' && e.fromIndex === c);
      expect(targets).toHaveLength(2);
    }
  });

  it('reflects per-backend locality overrides on the node', () => {
    const config = configWith({
      backends: {
        count: 2,
        defaults: { capacity: 8, latency: { kind: 'constant', value: 5 } },
        overrides: { '1': { locality: { region: 'r2', zone: 'z9' } } },
      },
    });
    const snap = makeTopologySnapshot(config, 0);
    expect(snap.backends[1]).toMatchObject({ region: 'r2', zone: 'z9' });
    expect(snap.backends[0]).toMatchObject({ region: 'r1', zone: 'z1' });
  });

  it('exercises saturation, health, and panic across many instants', () => {
    const config = configWith({
      clients: {
        count: 2,
        arrival: { kind: 'poisson', ratePerSec: 10 },
        requestKey: { kind: 'uniform', n: 100 },
        lb: { kind: 'round_robin' },
      },
      // Tiny capacities so nodes saturate often and exercise the queue branch.
      envoys: {
        count: 4,
        policy: { kind: 'maglev' },
        queue: { maxConcurrentRequests: 1, queueCapacity: 4 },
      },
      backends: {
        count: 6,
        defaults: { capacity: 1, latency: { kind: 'constant', value: 5 }, queueSize: 4 },
      },
    });
    let sawEnvoyQueue = false;
    let sawBackendQueue = false;
    let sawDegradedOrWorse = false;
    let sawPanic = false;
    for (let t = 0; t < 300; t++) {
      const snap = makeTopologySnapshot(config, t);
      for (const e of snap.envoys) {
        if (e.queueDepth > 0) sawEnvoyQueue = true;
        if (e.panic) sawPanic = true;
      }
      for (const b of snap.backends) {
        if (b.queueDepth > 0) sawBackendQueue = true;
        if (b.health > 0) sawDegradedOrWorse = true;
      }
    }
    expect(sawEnvoyQueue).toBe(true);
    expect(sawBackendQueue).toBe(true);
    expect(sawDegradedOrWorse).toBe(true);
    expect(sawPanic).toBe(true);
  });

  it('builds the full envoy -> backend mesh weighted by backend weight', () => {
    const config = configWith({
      envoys: { count: 2, policy: { kind: 'maglev' }, queue: { maxConcurrentRequests: 16 } },
      backends: {
        count: 3,
        defaults: { capacity: 8, latency: { kind: 'constant', value: 5 } },
        overrides: { '0': { weight: 2 } },
      },
    });
    const snap = makeTopologySnapshot(config, 0);
    const envoyEdges = snap.edges.filter((e) => e.fromKind === 'envoy');
    expect(envoyEdges).toHaveLength(2 * 3);
    // Backend 0 (weight 2 of total 4) carries twice the share of backend 1.
    const e0b0 = envoyEdges.find((e) => e.fromIndex === 0 && e.toIndex === 0)!;
    const e0b1 = envoyEdges.find((e) => e.fromIndex === 0 && e.toIndex === 1)!;
    expect(e0b0.share).toBeCloseTo(2 * e0b1.share);
  });
});
