/**
 * Deterministic pseudo-random generator. The whole simulation is reproducible
 * from `SimConfig.seed`: every stochastic draw (arrivals, latencies, LB tie
 * breaks) goes through one of these. The same seed must produce the same stream
 * across the TS kernel and, where it draws randomness, the Wasm LB; so the
 * algorithm (SplitMix64) is intentionally simple and portable to C++.
 */

const MASK64 = (1n << 64n) - 1n;
const GOLDEN = 0x9e3779b97f4a7c15n;

export class Prng {
  private state: bigint;

  constructor(seed: number | bigint) {
    // Mix the seed so small seeds (0, 1, 2) still yield well-spread streams.
    this.state = (BigInt(seed) * GOLDEN) & MASK64;
  }

  /** Next raw 64-bit value (SplitMix64). */
  nextU64(): bigint {
    this.state = (this.state + GOLDEN) & MASK64;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return (z ^ (z >> 31n)) & MASK64;
  }

  /** Uniform float in [0, 1). */
  nextFloat(): number {
    // Top 53 bits → an exact double in [0,1).
    return Number(this.nextU64() >> 11n) / 2 ** 53;
  }

  /** Uniform integer in [0, n). */
  nextInt(n: number): number {
    if (n <= 0) throw new Error('nextInt requires n > 0');
    return Math.floor(this.nextFloat() * n);
  }

  /** Fork an independent stream (e.g. one per entity) deterministically. */
  fork(streamId: number): Prng {
    return new Prng((this.state ^ (BigInt(streamId) * GOLDEN)) & MASK64);
  }
}
