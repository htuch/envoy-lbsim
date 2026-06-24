import type { Distribution } from '@elbsim/config';
import { describe, expect, it } from 'vitest';
import { Prng } from './prng';
import { sample, sampleKey, sampleZipf } from './sampling';

const seeded = () => new Prng(2024);

describe('sample', () => {
  it('constant returns the value', () => {
    expect(sample({ kind: 'constant', value: 5 }, seeded())).toBe(5);
  });

  it('uniform stays within bounds', () => {
    const rng = seeded();
    for (let i = 0; i < 500; i++) {
      const v = sample({ kind: 'uniform', min: 2, max: 8 }, rng);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThanOrEqual(8);
    }
  });

  it('non-negative-clamped distributions never go below zero', () => {
    const dists: Distribution[] = [
      { kind: 'normal', mean: 0, stddev: 5 },
      { kind: 'exponential', ratePerMs: 1 },
      { kind: 'lognormal', mu: 0, sigma: 1 },
      { kind: 'pareto', scale: 1, shape: 2 },
    ];
    const rng = seeded();
    for (const d of dists) {
      for (let i = 0; i < 200; i++) expect(sample(d, rng)).toBeGreaterThanOrEqual(0);
    }
  });

  it('is reproducible for a fixed seed', () => {
    const d: Distribution = { kind: 'lognormal', mu: 1, sigma: 0.5 };
    expect(sample(d, new Prng(11))).toEqual(sample(d, new Prng(11)));
  });
});

describe('sampleKey', () => {
  it('uniform keys are in range', () => {
    const rng = seeded();
    for (let i = 0; i < 200; i++) {
      const k = sampleKey({ kind: 'uniform', n: 50 }, rng);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThan(50);
    }
  });

  it('zipf keys are in range and skew toward low indices', () => {
    const rng = seeded();
    const counts = new Array(20).fill(0);
    for (let i = 0; i < 5000; i++) counts[sampleKey({ kind: 'zipf', n: 20, s: 1.2 }, rng)]++;
    expect(counts[0]).toBeGreaterThan(counts[19] as number);
  });

  it('sampleZipf returns the last index when the draw rounds to the tail', () => {
    // A PRNG whose first float is ~1 pushes the target to the final bucket.
    const nearOne = { nextFloat: () => 0.999999999 } as unknown as Prng;
    expect(sampleZipf(5, 1, nearOne)).toBe(4);
  });
});
