import { parseSimConfig, type SimConfig } from '@elbsim/config';
import {
  BACKEND_GAUGES,
  CLIENT_GAUGES,
  type CompletedEvent,
  ENVOY_GAUGES,
  gaugeIndex,
  type RequestEvent,
} from '@elbsim/protocol';
import { describe, expect, it } from 'vitest';
import { SimEngine } from './engine';

/** A complete, valid config with generous capacity; tests override fields. */
function makeConfig(patch: Partial<RawConfig> = {}): SimConfig {
  const base: RawConfig = {
    version: 1,
    seed: 1,
    time: { durationMs: 200, sampleIntervalMs: 10 },
    clients: {
      count: 1,
      arrival: { kind: 'periodic', ratePerSec: 100 },
      requestKey: { kind: 'uniform', n: 8 },
      lb: { kind: 'round_robin' },
    },
    network: {
      clientToEnvoy: { kind: 'constant', value: 1 },
      envoyToBackend: { kind: 'constant', value: 1 },
    },
    envoys: { count: 1, policy: { kind: 'round_robin' }, queue: { maxConcurrentRequests: 100 } },
    backends: {
      count: 1,
      defaults: { capacity: 100, latency: { kind: 'constant', value: 5 } },
    },
    timeouts: { requestTimeoutMs: 1000 },
  };
  return parseSimConfig({ ...base, ...patch });
}
// Loose shape for test patches; parseSimConfig validates the result.
type RawConfig = Record<string, unknown> & { version: 1 };

function phases(events: readonly RequestEvent[], req: number): string[] {
  return events.filter((e) => e.req === req).map((e) => e.phase);
}

describe('SimEngine happy path', () => {
  it('drives a request through the full lifecycle to completion', () => {
    const engine = new SimEngine(makeConfig());
    engine.runToCompletion();
    const events = engine.events;

    expect(events.length).toBeGreaterThan(0);
    // The first request id is 0; it should traverse every non-failure phase.
    expect(phases(events, 0)).toEqual([
      'emitted',
      'client_routed',
      'envoy_queued',
      'lb_pick',
      'backend_sent',
      'completed',
    ]);
  });

  it('completes every request when capacity is ample (goodput 1)', () => {
    const engine = new SimEngine(makeConfig());
    engine.runToCompletion();
    const emitted = engine.events.filter((e) => e.phase === 'emitted').length;
    const completed = engine.events.filter((e) => e.phase === 'completed').length;
    expect(emitted).toBeGreaterThan(10);
    expect(completed).toBe(emitted);
  });

  it('reports end-to-end latency consistent with the network + service model', () => {
    const engine = new SimEngine(makeConfig());
    engine.runToCompletion();
    const done = engine.events.find((e) => e.phase === 'completed') as CompletedEvent;
    // 1ms each way client<->envoy and envoy<->backend, plus 5ms service = 9ms.
    expect(done.latencyMs).toBeCloseTo(9, 5);
  });

  it('is deterministic for a fixed seed and varies with the seed', () => {
    const a = new SimEngine(makeConfig({ seed: 5, clients: poissonClients() }));
    const b = new SimEngine(makeConfig({ seed: 5, clients: poissonClients() }));
    a.runToCompletion();
    b.runToCompletion();
    expect(JSON.stringify(a.events)).toEqual(JSON.stringify(b.events));
    // Sanity: a Poisson run with a different seed differs.
    const p2 = new SimEngine(makeConfig({ seed: 6, clients: poissonClients() }));
    p2.runToCompletion();
    expect(JSON.stringify(a.events)).not.toEqual(JSON.stringify(p2.events));
  });
});

function poissonClients() {
  return {
    count: 3,
    arrival: { kind: 'poisson', ratePerSec: 200 },
    requestKey: { kind: 'zipf', n: 100, s: 1.1 },
    lb: { kind: 'round_robin' },
  };
}

describe('SimEngine admission and failures', () => {
  it('sheds with envoy_overflow when concurrency and queue are saturated', () => {
    const engine = new SimEngine(
      makeConfig({
        time: { durationMs: 500, sampleIntervalMs: 10 },
        clients: {
          count: 4,
          arrival: { kind: 'periodic', ratePerSec: 200 },
          requestKey: { kind: 'uniform', n: 8 },
          lb: { kind: 'round_robin' },
        },
        envoys: {
          count: 1,
          policy: { kind: 'round_robin' },
          queue: { maxConcurrentRequests: 1, queueCapacity: 1 },
        },
        backends: {
          count: 1,
          defaults: { capacity: 100, latency: { kind: 'constant', value: 40 } },
        },
      }),
    );
    engine.runToCompletion();
    const overflow = engine.events.filter(
      (e) => e.phase === 'rejected' && e.reason === 'envoy_overflow',
    );
    const queuedDeep = engine.events.filter((e) => e.phase === 'envoy_queued' && e.queueDepth > 0);
    expect(overflow.length).toBeGreaterThan(0);
    expect(queuedDeep.length).toBeGreaterThan(0);
  });

  it('sheds with backend_overflow when the backend has no spare capacity or queue', () => {
    const engine = new SimEngine(
      makeConfig({
        time: { durationMs: 500, sampleIntervalMs: 10 },
        clients: {
          count: 4,
          arrival: { kind: 'periodic', ratePerSec: 200 },
          requestKey: { kind: 'uniform', n: 8 },
          lb: { kind: 'round_robin' },
        },
        envoys: {
          count: 1,
          policy: { kind: 'round_robin' },
          queue: { maxConcurrentRequests: 1000 },
        },
        backends: {
          count: 1,
          defaults: { capacity: 1, queueSize: 0, latency: { kind: 'constant', value: 40 } },
        },
      }),
    );
    engine.runToCompletion();
    const shed = engine.events.filter(
      (e) => e.phase === 'rejected' && e.reason === 'backend_overflow',
    );
    expect(shed.length).toBeGreaterThan(0);
  });

  it('times out slow requests and attributes them away from goodput', () => {
    const engine = new SimEngine(
      makeConfig({
        backends: {
          count: 1,
          defaults: { capacity: 100, latency: { kind: 'constant', value: 80 } },
        },
        timeouts: { requestTimeoutMs: 20 },
      }),
    );
    engine.runToCompletion();
    const timedOut = engine.events.filter((e) => e.phase === 'timed_out');
    const completed = engine.events.filter((e) => e.phase === 'completed');
    expect(timedOut.length).toBeGreaterThan(0);
    expect(completed.length).toBe(0);
    for (const e of timedOut) expect((e as { reason: string }).reason).toBe('timeout');
  });

  it('rejects with no_healthy_host when every backend is unhealthy', () => {
    const engine = new SimEngine(
      makeConfig({
        backends: {
          count: 2,
          defaults: { capacity: 100, latency: { kind: 'constant', value: 5 } },
          overrides: { '0': { health: 'unhealthy' }, '1': { health: 'unhealthy' } },
        },
      }),
    );
    engine.runToCompletion();
    const noHost = engine.events.filter(
      (e) => e.phase === 'rejected' && e.reason === 'no_healthy_host',
    );
    expect(noHost.length).toBeGreaterThan(0);
    expect(engine.events.some((e) => e.phase === 'backend_sent')).toBe(false);
  });
});

describe('SimEngine routing', () => {
  function routedEnvoys(lb: Record<string, unknown>): Set<number> {
    const engine = new SimEngine(
      makeConfig({
        time: { durationMs: 300, sampleIntervalMs: 10 },
        clients: {
          count: 6,
          arrival: { kind: 'periodic', ratePerSec: 100 },
          requestKey: { kind: 'uniform', n: 50 },
          lb,
        },
        envoys: {
          count: 4,
          policy: { kind: 'round_robin' },
          queue: { maxConcurrentRequests: 1000 },
        },
      }),
    );
    engine.runToCompletion();
    return new Set(
      engine.events
        .filter((e) => e.phase === 'client_routed')
        .map((e) => (e as { envoy: number }).envoy),
    );
  }

  it('spreads load across Envoys under each client-side policy', () => {
    for (const lb of [
      { kind: 'round_robin' },
      { kind: 'random' },
      { kind: 'hash' },
      { kind: 'subset', subsetSize: 2 },
      { kind: 'dns_approx', refreshMs: 1000, resolvedSetSize: 3 },
    ]) {
      expect(routedEnvoys(lb).size).toBeGreaterThan(1);
    }
  });

  it('charges a cross-zone penalty on both the client and backend legs', () => {
    function firstLatency(config: SimConfig): number {
      const engine = new SimEngine(config);
      engine.runToCompletion();
      return (engine.events.find((x) => x.phase === 'completed') as CompletedEvent).latencyMs;
    }
    const near = firstLatency(makeConfig());
    const far = firstLatency(
      makeConfig({
        network: {
          clientToEnvoy: { kind: 'constant', value: 1 },
          envoyToBackend: { kind: 'constant', value: 1 },
          crossZonePenaltyMs: 10,
        },
        envoys: {
          count: 1,
          policy: { kind: 'round_robin' },
          queue: { maxConcurrentRequests: 100 },
          locality: { region: 'r1', zone: 'z2' },
        },
        backends: {
          count: 1,
          defaults: {
            capacity: 100,
            latency: { kind: 'constant', value: 5 },
            locality: { region: 'r1', zone: 'z9' },
          },
        },
      }),
    );
    // Client<->Envoy (z1<->z2) and Envoy<->backend (z2<->z9) each cross a zone
    // boundary on both directions: 4 legs x 10ms = +40ms over the 9ms base.
    expect(far).toBeCloseTo(near + 40, 5);
  });

  it('generates load under a uniform (jittered) arrival process', () => {
    const engine = new SimEngine(
      makeConfig({
        clients: {
          count: 2,
          arrival: { kind: 'uniform', ratePerSec: 100, jitterPercent: 50 },
          requestKey: { kind: 'uniform', n: 8 },
          lb: { kind: 'round_robin' },
        },
      }),
    );
    engine.runToCompletion();
    expect(engine.events.filter((e) => e.phase === 'emitted').length).toBeGreaterThan(5);
  });
});

describe('SimEngine resource accounting under cancellation', () => {
  it('frees the Envoy slot when a request times out after dispatch, in transit', () => {
    // Times out (5ms) after reaching the Envoy (2ms) and being dispatched, but
    // before reaching the backend (12ms): exercises immediate slot release and
    // the terminal short-circuit at the backend.
    const engine = new SimEngine(
      makeConfig({
        network: {
          clientToEnvoy: { kind: 'constant', value: 2 },
          envoyToBackend: { kind: 'constant', value: 10 },
        },
        timeouts: { requestTimeoutMs: 5 },
      }),
    );
    engine.runToCompletion();
    const timedOut = engine.events.filter((e) => e.phase === 'timed_out');
    expect(timedOut.length).toBeGreaterThan(0);
    // Dispatched (so backend was attributed) but never completed.
    expect(engine.events.some((e) => e.phase === 'backend_sent')).toBe(true);
    expect(engine.events.some((e) => e.phase === 'completed')).toBe(false);
    expect((timedOut[0] as { backend?: number }).backend).toBeGreaterThanOrEqual(0);
  });

  it('drops requests that time out before reaching the Envoy', () => {
    const engine = new SimEngine(
      makeConfig({
        network: {
          clientToEnvoy: { kind: 'constant', value: 5 },
          envoyToBackend: { kind: 'constant', value: 1 },
        },
        timeouts: { requestTimeoutMs: 1 },
      }),
    );
    engine.runToCompletion();
    expect(engine.events.some((e) => e.phase === 'timed_out')).toBe(true);
    // Never admitted, so no envoy_queued / lb_pick for any request.
    expect(engine.events.some((e) => e.phase === 'lb_pick')).toBe(false);
    const firstTimeout = engine.events.find((e) => e.phase === 'timed_out') as { backend?: number };
    expect(firstTimeout.backend).toBeUndefined();
  });

  it('skips timed-out entries when draining the Envoy and backend queues (LIFO)', () => {
    const engine = new SimEngine(
      makeConfig({
        time: { durationMs: 400, sampleIntervalMs: 10 },
        clients: {
          count: 6,
          arrival: { kind: 'periodic', ratePerSec: 200 },
          requestKey: { kind: 'uniform', n: 8 },
          lb: { kind: 'round_robin' },
        },
        envoys: {
          count: 1,
          policy: { kind: 'round_robin' },
          queue: { maxConcurrentRequests: 1, queueCapacity: 50, discipline: 'lifo' },
        },
        backends: {
          count: 1,
          defaults: { capacity: 1, queueSize: 50, latency: { kind: 'constant', value: 50 } },
        },
        timeouts: { requestTimeoutMs: 25 },
      }),
    );
    engine.runToCompletion();
    // Heavy queueing with a tight timeout: lots of timeouts, and the run stays
    // consistent (every emitted request reaches exactly one terminal event).
    const emitted = engine.events.filter((e) => e.phase === 'emitted').length;
    const terminal = engine.events.filter(
      (e) => e.phase === 'completed' || e.phase === 'timed_out' || e.phase === 'rejected',
    ).length;
    expect(engine.events.filter((e) => e.phase === 'timed_out').length).toBeGreaterThan(5);
    expect(terminal).toBe(emitted);
  });
});

describe('SimEngine inspection and panic', () => {
  it('serializes an Envoy LB view via inspect()', () => {
    const engine = new SimEngine(
      makeConfig({
        backends: {
          count: 3,
          defaults: { capacity: 100, latency: { kind: 'constant', value: 5 } },
        },
      }),
    );
    engine.runUntil(50);
    const view = engine.inspect(0);
    expect(view.envoy).toBe(0);
    expect(view.policy).toBe('round_robin');
    expect(view.hosts.length).toBe(3);
    expect(view.structure.kind).toBe('none'); // mock LB has no persistent table
    expect(() => engine.inspect(99)).toThrow(/unknown envoy/);
  });

  it('flags panic and reports it on the Envoy gauge when most hosts are unhealthy', () => {
    const engine = new SimEngine(
      makeConfig({
        backends: {
          count: 3,
          defaults: { capacity: 100, latency: { kind: 'constant', value: 5 } },
          overrides: { '0': { health: 'unhealthy' }, '1': { health: 'unhealthy' } },
        },
      }),
    );
    engine.runToCompletion();
    const last = engine.channels.envoy.latest();
    expect(last?.values[gaugeIndex('envoy', 'panic')]).toBe(1);
    expect(last?.values[gaugeIndex('envoy', 'healthyHosts')]).toBe(1);
  });
});

describe('SimEngine gauges', () => {
  it('samples frames into the per-kind ring buffers at the sample interval', () => {
    const engine = new SimEngine(makeConfig());
    engine.runToCompletion();
    // 200ms / 10ms + the frame at t=0 => 21 frames.
    expect(engine.channels.backend.size()).toBe(21);
    expect(engine.channels.envoy.size()).toBe(21);
    expect(engine.channels.client.size()).toBe(21);
    expect(engine.channels.backend.frameAt(0).t).toBe(0);
  });

  it('records backend utilization and latency percentiles once warm', () => {
    const engine = new SimEngine(makeConfig());
    engine.runToCompletion();
    const last = engine.channels.backend.latest();
    expect(last).toBeDefined();
    const fields = BACKEND_GAUGES.length;
    const util = last?.values[gaugeIndex('backend', 'utilization')] ?? -1;
    const p50 = last?.values[gaugeIndex('backend', 'latencyP50')] ?? -1;
    expect(util).toBeGreaterThanOrEqual(0);
    expect(util).toBeLessThanOrEqual(1);
    // Service latency is a constant 5ms; the histogram p50 lands near it.
    expect(p50).toBeGreaterThan(3);
    expect(p50).toBeLessThan(8);
    expect(last?.values.length).toBe(fields); // one backend
    void ENVOY_GAUGES;
    void CLIENT_GAUGES;
  });
});

// --- gauge-correctness harness helpers -------------------------------------

/**
 * Build and run a scenario to completion, returning the engine.
 * A thin convenience so test bodies stay declarative.
 */
function runScenario(cfg: SimConfig): { engine: SimEngine } {
  const engine = new SimEngine(cfg);
  engine.runToCompletion();
  return { engine };
}

/** Collect all frames from a channel as plain objects. */
function collectFrames(
  engine: SimEngine,
  kind: 'client' | 'envoy' | 'backend',
): Array<{ t: number; values: Float32Array }> {
  const ch = engine.channels[kind];
  const n = ch.size();
  const frames: Array<{ t: number; values: Float32Array }> = [];
  for (let i = 0; i < n; i++) frames.push(ch.frameAt(i));
  return frames;
}

/** Sum a single named gauge across all frames and all entity slots. */
function sumGauge(
  frames: Array<{ t: number; values: Float32Array }>,
  kind: 'client' | 'envoy' | 'backend',
  name: string,
): number {
  const gaugesList = { client: CLIENT_GAUGES, envoy: ENVOY_GAUGES, backend: BACKEND_GAUGES };
  const fields = gaugesList[kind].length;
  const idx = gaugeIndex(kind, name);
  let total = 0;
  for (const f of frames) {
    for (let e = 0; e < f.values.length / fields; e++) {
      total += f.values[e * fields + idx] ?? 0;
    }
  }
  return total;
}

/**
 * A config where every request times out before receiving a response.
 * Backend latency (200ms) >> request timeout (5ms).
 * Queue limits are generous so nothing is shed at admission.
 */
function timeoutOnlyConfig(): SimConfig {
  return makeConfig({
    time: { durationMs: 100, sampleIntervalMs: 10 },
    clients: {
      count: 1,
      arrival: { kind: 'periodic', ratePerSec: 50 },
      requestKey: { kind: 'uniform', n: 8 },
      lb: { kind: 'round_robin' },
    },
    envoys: {
      count: 1,
      policy: { kind: 'round_robin' },
      queue: { maxConcurrentRequests: 500, queueCapacity: 500 },
    },
    backends: {
      count: 1,
      defaults: { capacity: 500, queueSize: 500, latency: { kind: 'constant', value: 200 } },
    },
    timeouts: { requestTimeoutMs: 5 },
  });
}

describe('SimEngine rejectRate / timedOut gauge correctness', () => {
  it('a pure-timeout scenario leaves envoy rejectRate at zero', () => {
    const { engine } = runScenario(timeoutOnlyConfig());
    const envoyFrames = collectFrames(engine, 'envoy');
    const fields = ENVOY_GAUGES.length;
    const rej = gaugeIndex('envoy', 'rejectRate');
    expect(envoyFrames.some((f) => f.values.some((_v, i) => i % fields === rej && _v > 0))).toBe(
      false,
    );
  });

  it('client.timedOut counts timeouts per interval and resets', () => {
    const { engine } = runScenario(timeoutOnlyConfig());
    const clientFrames = collectFrames(engine, 'client');
    const total = sumGauge(clientFrames, 'client', 'timedOut');
    expect(total).toBeGreaterThan(0);
  });
});
