import { describe, expect, it } from 'vitest';
import { parseSimConfig, SimConfig, safeParseSimConfig } from './config';
import { defaultSimConfig } from './defaults';
import { Distribution, KeyDistribution } from './distributions';
import { BackendPool, BackendSpecOverride, resolveBackend } from './entities';
import { EnvoyLbPolicy, isPrime, LeastRequestPolicy, MaglevPolicy } from './lb-policies';

describe('SimConfig', () => {
  it('default scenario validates and materializes nested defaults', () => {
    const cfg = defaultSimConfig();
    expect(cfg.version).toBe(1);
    // CommonLbConfig defaults are filled in.
    expect(cfg.envoys.common.healthyPanicThresholdPercent).toBe(50);
    expect(cfg.envoys.common.overprovisioningFactor).toBe(140);
    // Backend defaults materialize health/weight.
    expect(cfg.backends.defaults.health).toBe('healthy');
    expect(cfg.backends.defaults.weight).toBe(1);
    // Round-trips through the schema unchanged.
    expect(parseSimConfig(cfg)).toEqual(cfg);
  });

  it('rejects an unknown schema version', () => {
    const cfg = { ...defaultSimConfig(), version: 2 };
    expect(safeParseSimConfig(cfg).success).toBe(false);
  });

  it('rejects a negative seed', () => {
    const result = SimConfig.safeParse({ ...defaultSimConfig(), seed: -1 });
    expect(result.success).toBe(false);
  });
});

describe('EnvoyLbPolicy', () => {
  it('applies Envoy-aligned defaults for least_request', () => {
    const p = LeastRequestPolicy.parse({ kind: 'least_request' });
    expect(p.choiceCount).toBe(2);
    expect(p.activeRequestBias).toBe(1);
    expect(p.selectionMethod).toBe('n_choices');
  });

  it('enforces least_request choiceCount >= 2', () => {
    expect(LeastRequestPolicy.safeParse({ kind: 'least_request', choiceCount: 1 }).success).toBe(
      false,
    );
  });

  it('defaults maglev tableSize to the Envoy default and caps it', () => {
    expect(MaglevPolicy.parse({ kind: 'maglev' }).tableSize).toBe(65537);
    expect(MaglevPolicy.safeParse({ kind: 'maglev', tableSize: 5_000_012 }).success).toBe(false);
  });

  it('rejects a non-prime maglev tableSize and accepts primes (Envoy requires prime)', () => {
    // 4096 is not prime: Envoy's Maglev aborts on a composite table size.
    expect(MaglevPolicy.safeParse({ kind: 'maglev', tableSize: 4096 }).success).toBe(false);
    expect(MaglevPolicy.parse({ kind: 'maglev', tableSize: 4099 }).tableSize).toBe(4099);
    expect(MaglevPolicy.parse({ kind: 'maglev', tableSize: 65537 }).tableSize).toBe(65537);
  });

  it('isPrime handles edge cases and small numbers', () => {
    expect(isPrime(-7)).toBe(false);
    expect(isPrime(0)).toBe(false);
    expect(isPrime(1)).toBe(false);
    expect(isPrime(2)).toBe(true);
    expect(isPrime(3)).toBe(true);
    expect(isPrime(4)).toBe(false);
    expect(isPrime(4096)).toBe(false);
    expect(isPrime(4099)).toBe(true);
    expect(isPrime(65537)).toBe(true);
  });

  it('discriminates policy kinds', () => {
    const ring = EnvoyLbPolicy.parse({ kind: 'ring_hash' });
    expect(ring.kind).toBe('ring_hash');
    if (ring.kind === 'ring_hash') {
      expect(ring.minimumRingSize).toBe(1024);
      expect(ring.hashFunction).toBe('xx_hash');
    }
  });
});

describe('backend overrides', () => {
  it('keeps overrides sparse: absent fields are not defaulted', () => {
    // Only weight is set; queueSize must NOT be materialized to its 0 default.
    const override = BackendSpecOverride.parse({ weight: 2 });
    expect(override).toEqual({ weight: 2 });
    expect(override.queueSize).toBeUndefined();
  });

  it('resolveBackend overlays only the set fields onto the pool default', () => {
    const pool = BackendPool.parse({
      count: 4,
      defaults: { capacity: 24, latency: { kind: 'constant', value: 5 }, queueSize: 48 },
      overrides: { '0': { weight: 2 }, '5': { health: 'degraded' } },
    });
    // Overridden weight applies; queueSize falls through to the pool default.
    expect(resolveBackend(pool, 0)).toMatchObject({ weight: 2, queueSize: 48, capacity: 24 });
    expect(resolveBackend(pool, 5)).toMatchObject({ health: 'degraded', queueSize: 48 });
    // A backend with no override is exactly the pool default.
    expect(resolveBackend(pool, 1)).toEqual(pool.defaults);
  });
});

describe('distributions', () => {
  it('accepts each distribution kind', () => {
    for (const d of [
      { kind: 'constant', value: 1 },
      { kind: 'uniform', min: 0, max: 1 },
      { kind: 'normal', mean: 1, stddev: 1 },
      { kind: 'exponential', ratePerMs: 0.5 },
      { kind: 'lognormal', mu: 1, sigma: 1 },
      { kind: 'pareto', scale: 1, shape: 2 },
    ]) {
      expect(Distribution.safeParse(d).success).toBe(true);
    }
  });

  it('rejects a non-positive exponential rate', () => {
    expect(Distribution.safeParse({ kind: 'exponential', ratePerMs: 0 }).success).toBe(false);
  });

  it('models zipf and uniform key distributions', () => {
    expect(KeyDistribution.safeParse({ kind: 'zipf', n: 100, s: 1.1 }).success).toBe(true);
    expect(KeyDistribution.safeParse({ kind: 'uniform', n: 100 }).success).toBe(true);
  });
});
