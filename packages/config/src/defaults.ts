import { type SimConfig, SimConfig as SimConfigSchema } from './config';

/**
 * A baseline scenario: a modest fleet under Poisson load through Maglev-balanced
 * Envoys to a homogeneous 8-backend service. Useful as the editor's starting
 * point and as a fixture in tests. Passed through the schema so all nested
 * defaults are materialized.
 */
export function defaultSimConfig(): SimConfig {
  return SimConfigSchema.parse({
    version: 1,
    seed: 1,
    time: { durationMs: 60_000, sampleIntervalMs: 10 },
    clients: {
      count: 50,
      arrival: { kind: 'poisson', ratePerSec: 20 },
      requestKey: { kind: 'zipf', n: 10_000, s: 1.1 },
      lb: { kind: 'round_robin' },
    },
    network: {
      clientToEnvoy: { kind: 'normal', mean: 2, stddev: 0.5 },
      envoyToBackend: { kind: 'normal', mean: 1, stddev: 0.25 },
      crossZonePenaltyMs: 3,
    },
    envoys: {
      count: 4,
      policy: { kind: 'maglev' },
      queue: { maxConcurrentRequests: 256, queueCapacity: 1024 },
    },
    backends: {
      count: 8,
      defaults: {
        capacity: 32,
        latency: { kind: 'lognormal', mu: 2.3, sigma: 0.4 },
        queueSize: 64,
      },
    },
    timeouts: { requestTimeoutMs: 250, retries: 0 },
  });
}
