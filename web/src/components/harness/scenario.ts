import { parseSimConfig, type SimConfig } from '@elbsim/config';

/**
 * A compact, legible scenario for the Track D harness. The default scenario
 * (50 clients) is faithful but too dense to read in a topology graph, so the
 * harness drives the views from a smaller fleet. The view components are
 * prop-driven and scale to any size; this only bounds what the demo renders.
 *
 * The scenario fixes the Envoy policy at Maglev; the inspector previews the
 * other LB structures by overriding the policy kind when it builds an
 * inspection, so the scenario itself need not vary.
 */
export function harnessScenario(): SimConfig {
  return parseSimConfig({
    version: 1,
    seed: 7,
    time: { durationMs: 60_000, sampleIntervalMs: 10 },
    clients: {
      count: 8,
      arrival: { kind: 'poisson', ratePerSec: 25 },
      requestKey: { kind: 'zipf', n: 10_000, s: 1.1 },
      lb: { kind: 'round_robin' },
    },
    network: {
      clientToEnvoy: { kind: 'normal', mean: 2, stddev: 0.5 },
      envoyToBackend: { kind: 'normal', mean: 1, stddev: 0.25 },
      crossZonePenaltyMs: 3,
    },
    envoys: {
      count: 3,
      policy: { kind: 'maglev', tableSize: 65537 },
      queue: { maxConcurrentRequests: 64, queueCapacity: 256 },
    },
    backends: {
      count: 6,
      defaults: {
        capacity: 24,
        latency: { kind: 'lognormal', mu: 2.3, sigma: 0.4 },
        queueSize: 48,
      },
      overrides: { '0': { weight: 2 }, '5': { health: 'degraded' } },
    },
    timeouts: { requestTimeoutMs: 250, retries: 0 },
  });
}
