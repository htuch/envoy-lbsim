import type { SimConfig } from '@elbsim/config';
import type { WindowAggregate } from '@elbsim/protocol';
import { Prng, sample } from '@elbsim/sim-core';

/**
 * Synthetic cold-path window data for the Track D harness.
 *
 * The real cold path scans the `RequestEvent` stream over a committed brushed
 * window (Track B's `SimWorkerApi.queryWindow`). Until that lands, this module
 * synthesizes the same shape: per-request completed latencies plus terminal
 * outcome counts. The analytical charts render the latency distribution from the
 * sample array (a `WindowAggregate` carries only percentiles, not samples),
 * while {@link computeWindowAggregate} mirrors the aggregate `queryWindow` will
 * return so the summary read-outs match the eventual real path.
 */

/** A window of completed-request latencies plus terminal outcome counts. */
export interface LatencyWindow {
  fromMs: number;
  toMs: number;
  /** Latencies (ms) of requests that completed within the window. */
  latencies: number[];
  timedOut: number;
  rejected: number;
}

/** Mean per-client arrival rate (requests/sec) regardless of process kind. */
function clientRatePerSec(config: SimConfig): number {
  return config.clients.arrival.ratePerSec;
}

/**
 * Synthesize a latency window for `[fromMs, toMs)`. Request volume scales with
 * the configured arrival rate; latencies are drawn from the backend service-time
 * distribution plus a fixed network component, and a small fraction are marked
 * timed out (over the request timeout) or rejected.
 */
export function makeLatencyWindow(
  config: SimConfig,
  fromMs: number,
  toMs: number,
  seed = config.seed,
): LatencyWindow {
  const rng = new Prng(seed).fork(Math.floor(fromMs) ^ Math.floor(toMs));
  const windowSec = Math.max(0, toMs - fromMs) / 1000;
  const offeredRaw = Math.round(config.clients.count * clientRatePerSec(config) * windowSec);
  // Keep the cold-path sample set to a few thousand points (per ARCHITECTURE).
  const offered = Math.min(offeredRaw, 4000);

  const networkMs =
    config.network.clientToEnvoy.kind === 'constant'
      ? config.network.clientToEnvoy.value
      : 2 * Math.max(0, sample(config.network.clientToEnvoy, rng));
  const timeout = config.timeouts.requestTimeoutMs;

  const latencies: number[] = [];
  let timedOut = 0;
  let rejected = 0;
  for (let i = 0; i < offered; i++) {
    // ~3% rejected outright (envoy/backend overflow), independent of latency.
    if (rng.nextFloat() < 0.03) {
      rejected++;
      continue;
    }
    const latency = networkMs + sample(config.backends.defaults.latency, rng);
    if (latency > timeout) {
      timedOut++;
    } else {
      latencies.push(latency);
    }
  }

  return { fromMs, toMs, latencies, timedOut, rejected };
}

/** Nearest-rank percentile over an already-sorted ascending array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx]!;
}

/**
 * Reduce a {@link LatencyWindow} to the {@link WindowAggregate} the worker's
 * `queryWindow` will return. Goodput = completed-in-time / total offered.
 */
export function computeWindowAggregate(win: LatencyWindow): WindowAggregate {
  const completed = win.latencies.length;
  const total = completed + win.timedOut + win.rejected;
  const sorted = [...win.latencies].sort((a, b) => a - b);
  return {
    fromMs: win.fromMs,
    toMs: win.toMs,
    totalRequests: total,
    completed,
    timedOut: win.timedOut,
    rejected: win.rejected,
    goodput: total > 0 ? completed / total : 0,
    latencyP50: percentile(sorted, 50),
    latencyP90: percentile(sorted, 90),
    latencyP99: percentile(sorted, 99),
  };
}
