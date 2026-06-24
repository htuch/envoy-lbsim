import { describe, expect, it } from 'vitest';
import { Prng } from './prng';

describe('Prng', () => {
  it('is deterministic for a given seed', () => {
    const a = new Prng(42);
    const b = new Prng(42);
    const seqA = Array.from({ length: 5 }, () => a.nextU64());
    const seqB = Array.from({ length: 5 }, () => b.nextU64());
    expect(seqA).toEqual(seqB);
  });

  it('produces different streams for different seeds', () => {
    expect(new Prng(1).nextU64()).not.toEqual(new Prng(2).nextU64());
  });

  it('nextFloat is in [0,1)', () => {
    const rng = new Prng(7);
    for (let i = 0; i < 1000; i++) {
      const f = rng.nextFloat();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });

  it('nextInt is in [0,n) and rejects n<=0', () => {
    const rng = new Prng(3);
    for (let i = 0; i < 100; i++) {
      const v = rng.nextInt(10);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(10);
    }
    expect(() => rng.nextInt(0)).toThrow();
  });

  it('fork yields an independent but deterministic stream', () => {
    const base = new Prng(99);
    const f1 = base.fork(1).nextU64();
    const f1again = new Prng(99).fork(1).nextU64();
    expect(f1).toEqual(f1again);
    expect(base.fork(1).nextU64()).not.toEqual(base.fork(2).nextU64());
  });

  it('accepts a bigint seed', () => {
    expect(new Prng(123n).nextFloat()).toBeGreaterThanOrEqual(0);
  });
});
