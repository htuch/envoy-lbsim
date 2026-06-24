import { parseSimConfig, type SimConfig } from '@elbsim/config';
import { ringByteLengths } from '@elbsim/protocol';
import { describe, expect, it } from 'vitest';
import { SimController, type Ticker } from './controller';
import { mockLbModule } from './mock-lb';

function makeConfig(patch: Record<string, unknown> = {}): SimConfig {
  return parseSimConfig({
    version: 1,
    seed: 1,
    time: { durationMs: 200, sampleIntervalMs: 10 },
    clients: {
      count: 2,
      arrival: { kind: 'periodic', ratePerSec: 200 },
      requestKey: { kind: 'uniform', n: 8 },
      lb: { kind: 'round_robin' },
    },
    network: {
      clientToEnvoy: { kind: 'constant', value: 1 },
      envoyToBackend: { kind: 'constant', value: 1 },
    },
    envoys: { count: 2, policy: { kind: 'round_robin' }, queue: { maxConcurrentRequests: 100 } },
    backends: { count: 3, defaults: { capacity: 100, latency: { kind: 'constant', value: 5 } } },
    timeouts: { requestTimeoutMs: 1000 },
    ...patch,
  });
}

/** A ticker the test fires by hand, so playback advances deterministically. */
class ManualTicker implements Ticker {
  private cb: (() => void) | undefined;
  start(cb: () => void): void {
    this.cb = cb;
  }
  stop(): void {
    this.cb = undefined;
  }
  fire(times = 1): void {
    for (let i = 0; i < times; i++) this.cb?.();
  }
  get running(): boolean {
    return this.cb !== undefined;
  }
}

describe('SimController telemetry handles', () => {
  it('loadConfig returns one shared channel per entity kind with correct layout', async () => {
    const c = new SimController();
    const tele = await c.loadConfig(makeConfig());
    expect(tele.channels.map((ch) => ch.spec.kind)).toEqual(['client', 'envoy', 'backend']);
    const backend = tele.channels.find((ch) => ch.spec.kind === 'backend');
    expect(backend?.spec.entityCount).toBe(3);
    expect(backend?.spec.capacity).toBe(21); // 200/10 + 1
    expect(backend?.control).toBeInstanceOf(SharedArrayBuffer);
    expect(backend?.data.byteLength).toBe(ringByteLengths(backend!.spec).data);
    const status = await c.status();
    expect(status).toEqual({ state: 'idle', virtualTimeMs: 0, speed: 0 });
  });
});

describe('SimController stepping and playback', () => {
  it('step advances exactly one sample interval and writes a frame', async () => {
    const c = new SimController();
    const tele = await c.loadConfig(makeConfig());
    await c.step();
    expect((await c.status()).virtualTimeMs).toBe(10);
    // Frames at t=0 and t=10 are now visible in the shared backend buffer.
    const backend = tele.channels.find((ch) => ch.spec.kind === 'backend')!;
    const count = new Int32Array(backend.control)[1];
    expect(count).toBe(2);
  });

  it('play advances virtual time per tick and finishes at the horizon', async () => {
    const ticker = new ManualTicker();
    const c = new SimController({ ticker });
    await c.loadConfig(makeConfig());
    await c.play();
    expect(ticker.running).toBe(true);
    expect((await c.status()).speed).toBe(1);
    ticker.fire(); // speed 1 * 16ms wall => +16ms virtual
    expect((await c.status()).virtualTimeMs).toBe(16);
    ticker.fire(100); // run well past the 200ms horizon
    const status = await c.status();
    expect(status.state).toBe('finished');
    expect(status.virtualTimeMs).toBe(200);
    expect(ticker.running).toBe(false);
  });

  it('pause stops the ticker and reports speed 0', async () => {
    const ticker = new ManualTicker();
    const c = new SimController({ ticker });
    await c.loadConfig(makeConfig());
    await c.play();
    ticker.fire();
    await c.pause();
    expect(ticker.running).toBe(false);
    const status = await c.status();
    expect(status.state).toBe('paused');
    expect(status.speed).toBe(0);
  });

  it('setSpeed scales how far each tick advances', async () => {
    const ticker = new ManualTicker();
    const c = new SimController({ ticker });
    await c.loadConfig(makeConfig());
    await c.setSpeed(3);
    await c.play();
    ticker.fire();
    expect((await c.status()).virtualTimeMs).toBe(48); // 3 * 16
  });

  it('drives play/pause through the real interval ticker and a custom LB module', async () => {
    // Exercises the default IntervalTicker (start/stop) and the injected LB path.
    const c = new SimController({ lbModule: mockLbModule });
    await c.loadConfig(makeConfig());
    await c.play();
    expect((await c.status()).state).toBe('running');
    await c.pause(); // clears the real interval before any wall tick elapses
    expect((await c.status()).state).toBe('paused');
  });

  it('keeps the finished state through pause and step at the horizon', async () => {
    const ticker = new ManualTicker();
    const c = new SimController({ ticker });
    await c.loadConfig(makeConfig());
    await c.seek(200);
    expect((await c.status()).state).toBe('finished');
    await c.play();
    expect(ticker.running).toBe(false);
    await c.pause();
    await c.step();
    expect((await c.status()).state).toBe('finished'); // never reverts to paused
  });

  it('throws if driven before a config is loaded', async () => {
    const c = new SimController();
    await expect(c.step()).rejects.toThrow(/loadConfig/);
    await expect(c.queryWindow({ fromMs: 0, toMs: 1 })).rejects.toThrow(/loadConfig/);
  });
});

describe('SimController seeking', () => {
  it('seeks forward by advancing and backward by deterministic replay', async () => {
    const c = new SimController();
    const tele = await c.loadConfig(makeConfig());
    const backend = tele.channels.find((ch) => ch.spec.kind === 'backend')!;
    const count = () => new Int32Array(backend.control)[1] as number;

    await c.seek(100);
    expect((await c.status()).virtualTimeMs).toBe(100);
    expect(count()).toBe(11); // frames at 0,10,...,100

    await c.seek(40);
    expect((await c.status()).virtualTimeMs).toBe(40);
    expect(count()).toBe(5); // ring was reset and refilled: 0,10,20,30,40
  });

  it('clamps a seek beyond the horizon', async () => {
    const c = new SimController();
    await c.loadConfig(makeConfig());
    await c.seek(10_000);
    expect((await c.status()).virtualTimeMs).toBe(200);
  });
});

describe('SimController cold-path queries', () => {
  it('aggregates a window over the full deterministic run', async () => {
    const c = new SimController();
    await c.loadConfig(makeConfig());
    const agg = await c.queryWindow({ fromMs: 0, toMs: 200 });
    const again = await c.queryWindow({ fromMs: 0, toMs: 200 }); // hits the cache
    expect(again).toEqual(agg);
    expect(agg.fromMs).toBe(0);
    expect(agg.toMs).toBe(200);
    expect(agg.totalRequests).toBeGreaterThan(0);
    expect(agg.completed).toBe(agg.totalRequests); // ample capacity => all succeed
    expect(agg.goodput).toBeCloseTo(1, 5);
    // Constant 5ms service + 4ms network => ~9ms end to end.
    expect(agg.latencyP50).toBeGreaterThan(7);
    expect(agg.latencyP50).toBeLessThan(11);
    expect(agg.latencyP99).toBeGreaterThanOrEqual(agg.latencyP50);
  });

  it('reports failures and reduced goodput under saturation', async () => {
    const c = new SimController();
    await c.loadConfig(
      makeConfig({
        backends: {
          count: 1,
          defaults: { capacity: 1, queueSize: 0, latency: { kind: 'constant', value: 40 } },
        },
        timeouts: { requestTimeoutMs: 30 },
      }),
    );
    const agg = await c.queryWindow({ fromMs: 0, toMs: 200 });
    expect(agg.rejected + agg.timedOut).toBeGreaterThan(0);
    expect(agg.goodput).toBeLessThan(1);
  });

  it('returns an empty aggregate for a window with no emissions', async () => {
    const c = new SimController();
    await c.loadConfig(makeConfig());
    const agg = await c.queryWindow({ fromMs: 1000, toMs: 2000 });
    expect(agg.totalRequests).toBe(0);
    expect(agg.completed).toBe(0);
    expect(agg.goodput).toBe(0);
    expect(agg.latencyP50).toBe(0);
  });

  it('inspects an Envoy at a past instant via replay', async () => {
    const c = new SimController();
    await c.loadConfig(makeConfig());
    await c.seek(200);
    const view = await c.requestInspection(1, 50);
    expect(view.envoy).toBe(1);
    expect(view.t).toBe(50);
    expect(view.hosts.length).toBe(3);
    expect(view.policy).toBe('round_robin');
  });
});
