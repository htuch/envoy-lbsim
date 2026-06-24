import { z } from 'zod';

/**
 * Statistical distributions used throughout the simulator: request inter-arrival
 * times, processing latencies, network delays, and request-key selection.
 *
 * All distributions are sampled by the deterministic PRNG in the sim kernel, so
 * a given {@link SimConfig.seed} reproduces an identical run. Time-valued
 * distributions are interpreted in **virtual milliseconds** unless stated
 * otherwise; the kernel owns the conversion.
 */

const positive = z.number().positive();
const nonNegative = z.number().nonnegative();

/** A single fixed value (degenerate distribution). */
export const ConstantDist = z.object({
  kind: z.literal('constant'),
  value: nonNegative,
});

/** Uniform over [min, max]. */
export const UniformDist = z.object({
  kind: z.literal('uniform'),
  min: nonNegative,
  max: nonNegative,
});

/** Gaussian; samples are clamped at 0 by consumers that need non-negative values. */
export const NormalDist = z.object({
  kind: z.literal('normal'),
  mean: nonNegative,
  stddev: nonNegative,
});

/**
 * Exponential with the given rate (events per ms). Inter-arrival times drawn
 * from this produce a Poisson arrival process.
 */
export const ExponentialDist = z.object({
  kind: z.literal('exponential'),
  ratePerMs: positive,
});

/** Log-normal, parameterized by the underlying normal's mu/sigma. Good for latency tails. */
export const LogNormalDist = z.object({
  kind: z.literal('lognormal'),
  mu: z.number(),
  sigma: positive,
});

/** Pareto (heavy tail), parameterized by scale (xm) and shape (alpha). */
export const ParetoDist = z.object({
  kind: z.literal('pareto'),
  scale: positive,
  shape: positive,
});

export const Distribution = z.discriminatedUnion('kind', [
  ConstantDist,
  UniformDist,
  NormalDist,
  ExponentialDist,
  LogNormalDist,
  ParetoDist,
]);
export type Distribution = z.infer<typeof Distribution>;

/**
 * Distribution over a discrete key space of size `n`, used to model which
 * resource/shard a request targets (the input to hash-based load balancing).
 */
export const KeyDistribution = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('uniform'), n: z.number().int().positive() }),
  // Zipf: P(k) ~ 1 / k^s over keys 1..n. `s` near 1 yields a hot-key workload.
  z.object({
    kind: z.literal('zipf'),
    n: z.number().int().positive(),
    s: z.number().positive(),
  }),
]);
export type KeyDistribution = z.infer<typeof KeyDistribution>;
