import { defaultSimConfig, parseSimConfig, type SimConfig } from '@elbsim/config';
import { Prng } from '@elbsim/sim-core';
import { describe, expect, it } from 'vitest';
import { clientEnvoyTargets, makeEdges } from './topology-edges';

function configWith(overrides: Record<string, unknown>): SimConfig {
  return parseSimConfig({ ...defaultSimConfig(), ...overrides });
}

describe('makeEdges', () => {
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
    const rng = new Prng(config.seed);
    const edges = makeEdges(config, rng);
    const clientEdges = edges.filter((e) => e.fromKind === 'client');
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
    const rng = new Prng(config.seed);
    const edges = makeEdges(config, rng);
    const clientEdges = edges.filter((e) => e.fromKind === 'client');
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
    const rng = new Prng(config.seed);
    const edges = makeEdges(config, rng);
    for (let c = 0; c < 5; c++) {
      const targets = edges.filter((e) => e.fromKind === 'client' && e.fromIndex === c);
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
    const rng = new Prng(config.seed);
    const edges = makeEdges(config, rng);
    for (let c = 0; c < 4; c++) {
      const targets = edges.filter((e) => e.fromKind === 'client' && e.fromIndex === c);
      expect(targets).toHaveLength(2);
    }
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
    const rng = new Prng(config.seed);
    const edges = makeEdges(config, rng);
    const envoyEdges = edges.filter((e) => e.fromKind === 'envoy');
    expect(envoyEdges).toHaveLength(2 * 3);
    // Backend 0 (weight 2 of total 4) carries twice the share of backend 1.
    const e0b0 = envoyEdges.find((e) => e.fromIndex === 0 && e.toIndex === 0)!;
    const e0b1 = envoyEdges.find((e) => e.fromIndex === 0 && e.toIndex === 1)!;
    expect(e0b0.share).toBeCloseTo(2 * e0b1.share);
  });
});

describe('clientEnvoyTargets', () => {
  it('returns all envoys for round_robin', () => {
    const config = configWith({
      clients: {
        count: 1,
        arrival: { kind: 'poisson', ratePerSec: 10 },
        requestKey: { kind: 'uniform', n: 100 },
        lb: { kind: 'round_robin' },
      },
      envoys: { count: 3, policy: { kind: 'maglev' }, queue: { maxConcurrentRequests: 16 } },
    });
    const rng = new Prng(config.seed);
    expect(clientEnvoyTargets(config, 0, rng)).toEqual([0, 1, 2]);
  });

  it('returns a single sticky envoy for hash', () => {
    const config = configWith({
      clients: {
        count: 1,
        arrival: { kind: 'poisson', ratePerSec: 10 },
        requestKey: { kind: 'uniform', n: 100 },
        lb: { kind: 'hash' },
      },
      envoys: { count: 3, policy: { kind: 'maglev' }, queue: { maxConcurrentRequests: 16 } },
    });
    const rng = new Prng(config.seed);
    // Client 0 with 3 envoys -> index 0 % 3 = 0
    expect(clientEnvoyTargets(config, 0, rng)).toEqual([0]);
    // Client 4 with 3 envoys -> index 4 % 3 = 1
    expect(clientEnvoyTargets(config, 4, rng)).toEqual([1]);
  });
});
