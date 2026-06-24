import {
  type EnvoyLbPolicyKind,
  type SimConfig,
  SimConfig as SimConfigSchema,
} from '@elbsim/config';

export interface ScenarioOpts {
  backends?: number;
  durationMs?: number;
  ratePerSec?: number;
  /** Sparse per-backend overrides keyed by stringified index. */
  overrides?: Record<string, unknown>;
}

/**
 * A compact, deterministic scenario for validation: a couple of Envoys under
 * steady Poisson load to a homogeneous backend pool, with the policy under test.
 * Short by design so the full suite runs fast. Parsed through the schema so all
 * nested defaults (CommonLbConfig, policy params) are materialized.
 */
export function scenario(policy: EnvoyLbPolicyKind, opts: ScenarioOpts = {}): SimConfig {
  return SimConfigSchema.parse({
    version: 1,
    seed: 1,
    time: { durationMs: opts.durationMs ?? 5_000, sampleIntervalMs: 50 },
    clients: {
      count: 20,
      arrival: { kind: 'poisson', ratePerSec: opts.ratePerSec ?? 50 },
      requestKey: { kind: 'zipf', n: 1_000, s: 1.1 },
      lb: { kind: 'round_robin' },
    },
    network: {
      clientToEnvoy: { kind: 'normal', mean: 2, stddev: 0.5 },
      envoyToBackend: { kind: 'normal', mean: 1, stddev: 0.25 },
      crossZonePenaltyMs: 3,
    },
    envoys: {
      count: 2,
      policy: { kind: policy },
      queue: { maxConcurrentRequests: 256, queueCapacity: 1_024 },
    },
    backends: {
      count: opts.backends ?? 6,
      defaults: {
        capacity: 32,
        latency: { kind: 'lognormal', mu: 2.3, sigma: 0.4 },
        queueSize: 64,
      },
      ...(opts.overrides ? { overrides: opts.overrides } : {}),
    },
    timeouts: { requestTimeoutMs: 250, retries: 0 },
  });
}
