import { defaultSimConfig, parseSimConfig, type SimConfig } from '@elbsim/config';
import { describe, expect, it } from 'vitest';
import { computeWindowAggregate, makeLatencyWindow } from './window';

function configWith(overrides: Record<string, unknown>): SimConfig {
  return parseSimConfig({ ...defaultSimConfig(), ...overrides });
}

describe('makeLatencyWindow', () => {
  it('is deterministic for the same (config, window, seed)', () => {
    const config = defaultSimConfig();
    expect(makeLatencyWindow(config, 0, 1000)).toEqual(makeLatencyWindow(config, 0, 1000));
  });

  it('scales request volume with arrival rate and window width', () => {
    const config = defaultSimConfig();
    const short = makeLatencyWindow(config, 0, 100);
    const long = makeLatencyWindow(config, 0, 1000);
    const shortTotal = short.latencies.length + short.timedOut + short.rejected;
    const longTotal = long.latencies.length + long.timedOut + long.rejected;
    expect(longTotal).toBeGreaterThan(shortTotal);
  });

  it('caps the sample set at a few thousand points', () => {
    const config = defaultSimConfig();
    const win = makeLatencyWindow(config, 0, 10_000_000);
    const total = win.latencies.length + win.timedOut + win.rejected;
    expect(total).toBeLessThanOrEqual(4000);
  });

  it('marks requests over the timeout as timed out', () => {
    // Constant 500ms service exceeds the 250ms default timeout: zero completions.
    const config = configWith({
      backends: {
        count: 4,
        defaults: { capacity: 8, latency: { kind: 'constant', value: 500 } },
      },
      network: {
        clientToEnvoy: { kind: 'constant', value: 0 },
        envoyToBackend: { kind: 'constant', value: 0 },
      },
      timeouts: { requestTimeoutMs: 250 },
    });
    const win = makeLatencyWindow(config, 0, 1000);
    expect(win.latencies).toHaveLength(0);
    expect(win.timedOut).toBeGreaterThan(0);
  });

  it('empty window yields no requests', () => {
    const win = makeLatencyWindow(defaultSimConfig(), 500, 500);
    expect(win.latencies).toHaveLength(0);
    expect(win.timedOut).toBe(0);
    expect(win.rejected).toBe(0);
  });
});

describe('computeWindowAggregate', () => {
  it('computes counts, goodput, and percentiles from the window', () => {
    const agg = computeWindowAggregate({
      fromMs: 0,
      toMs: 1000,
      latencies: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
      timedOut: 5,
      rejected: 5,
    });
    expect(agg.completed).toBe(10);
    expect(agg.timedOut).toBe(5);
    expect(agg.rejected).toBe(5);
    expect(agg.totalRequests).toBe(20);
    expect(agg.goodput).toBeCloseTo(0.5);
    expect(agg.latencyP50).toBe(50);
    expect(agg.latencyP90).toBe(90);
    expect(agg.latencyP99).toBe(100);
  });

  it('reports zero goodput and percentiles for an empty window', () => {
    const agg = computeWindowAggregate({
      fromMs: 0,
      toMs: 0,
      latencies: [],
      timedOut: 0,
      rejected: 0,
    });
    expect(agg.totalRequests).toBe(0);
    expect(agg.goodput).toBe(0);
    expect(agg.latencyP50).toBe(0);
    expect(agg.latencyP99).toBe(0);
  });

  it('sorts latencies before taking percentiles', () => {
    const agg = computeWindowAggregate({
      fromMs: 0,
      toMs: 1,
      latencies: [100, 10, 50],
      timedOut: 0,
      rejected: 0,
    });
    expect(agg.latencyP50).toBe(50);
  });
});
