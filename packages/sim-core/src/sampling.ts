import type { Distribution, KeyDistribution } from '@elbsim/config';
import type { Prng } from './prng';

/**
 * Draw samples from the config-level {@link Distribution} types using a
 * {@link Prng}. Time-valued samples are clamped at 0 so a wide Normal never
 * yields a negative latency. This is the single place config distributions
 * become numbers, so the kernel and tests agree on semantics.
 */
export function sample(dist: Distribution, rng: Prng): number {
  switch (dist.kind) {
    case 'constant':
      return dist.value;
    case 'uniform':
      return dist.min + (dist.max - dist.min) * rng.nextFloat();
    case 'normal':
      return Math.max(0, dist.mean + dist.stddev * gaussian(rng));
    case 'exponential':
      return -Math.log(1 - rng.nextFloat()) / dist.ratePerMs;
    case 'lognormal':
      return Math.exp(dist.mu + dist.sigma * gaussian(rng));
    case 'pareto':
      return dist.scale / (1 - rng.nextFloat()) ** (1 / dist.shape);
  }
}

/** Standard normal via Box-Muller. */
function gaussian(rng: Prng): number {
  // Avoid log(0); nextFloat() is in [0,1).
  const u1 = 1 - rng.nextFloat();
  const u2 = rng.nextFloat();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Sample a key in [0, n) from a {@link KeyDistribution}. Zipf uses the standard
 * normalized rank distribution P(k) ~ 1/(k+1)^s; the table is built once per
 * call here for clarity (the kernel caches it per client pool).
 */
export function sampleKey(dist: KeyDistribution, rng: Prng): number {
  if (dist.kind === 'uniform') return rng.nextInt(dist.n);
  return sampleZipf(dist.n, dist.s, rng);
}

/**
 * Build a reusable key sampler that precomputes the (expensive) Zipf CDF once,
 * then draws in O(log n) per call. The kernel creates one per client pool so a
 * 10k-key Zipf isn't rebuilt on every request. The draw sequence is identical
 * to {@link sampleKey} for the same PRNG, so determinism is preserved.
 */
export function createKeySampler(dist: KeyDistribution): (rng: Prng) => number {
  if (dist.kind === 'uniform') {
    const { n } = dist;
    return (rng) => rng.nextInt(n);
  }
  // Prefix sums in the same accumulation order as sampleZipf, so a binary search
  // for the crossing bucket returns the identical index.
  const { n, s } = dist;
  const prefix = new Float64Array(n + 1);
  for (let k = 1; k <= n; k++) prefix[k] = (prefix[k - 1] as number) + 1 / k ** s;
  const norm = prefix[n] as number;
  return (rng) => {
    const target = rng.nextFloat() * norm;
    // Smallest k in [1, n] with prefix[k] >= target; return the 0-based key.
    let lo = 1;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((prefix[mid] as number) >= target) hi = mid;
      else lo = mid + 1;
    }
    return lo - 1;
  };
}

/** Build a Zipf CDF over n keys with exponent s and draw one index. */
export function sampleZipf(n: number, s: number, rng: Prng): number {
  let norm = 0;
  for (let k = 1; k <= n; k++) norm += 1 / k ** s;
  const target = rng.nextFloat() * norm;
  let cumulative = 0;
  for (let k = 1; k <= n; k++) {
    cumulative += 1 / k ** s;
    if (cumulative >= target) return k - 1;
  }
  return n - 1;
}
