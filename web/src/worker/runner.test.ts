import { defaultSimConfig, type SimConfig } from '@elbsim/config';
import { GaugeRingBuffer, type SharedTelemetry } from '@elbsim/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_CAPACITY, MockSimRunner, runCapacity } from './runner';

/** A short run so frame counts are small and exhaustible in a test. */
function shortConfig(): SimConfig {
  const base = defaultSimConfig();
  return { ...base, time: { durationMs: 100, sampleIntervalMs: 10 } };
}

/** Read view over the envoy channel of a returned telemetry handle. */
function envoyRing(t: SharedTelemetry): GaugeRingBuffer {
  const ch = t.channels.find((c) => c.spec.kind === 'envoy');
  if (!ch) throw new Error('no envoy channel');
  return new GaugeRingBuffer(
    ch.spec,
    new Int32Array(ch.control),
    new Float64Array(ch.time),
    new Float32Array(ch.data),
  );
}

describe('runCapacity', () => {
  it('retains the whole run when short', () => {
    expect(runCapacity(shortConfig())).toBe(11); // frames at 0,10,..,100
  });
  it('caps a long run at MAX_CAPACITY', () => {
    const cfg = { ...defaultSimConfig(), time: { durationMs: 10_000_000, sampleIntervalMs: 1 } };
    expect(runCapacity(cfg)).toBe(MAX_CAPACITY);
  });
});

describe('MockSimRunner', () => {
  // Fake timers also fake `performance.now`, so advancing the timer advances the
  // play loop's wall clock; at speed 1 elapsed wall ms === virtual ms.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports idle before a config is loaded', async () => {
    const runner = new MockSimRunner();
    expect(await runner.status()).toEqual({ state: 'idle', virtualTimeMs: 0, speed: 0 });
  });

  it('guards control methods until a config is loaded', async () => {
    const runner = new MockSimRunner();
    await expect(runner.play()).rejects.toThrow(/loadConfig/);
  });

  it('loads telemetry channels and seeds the t=0 frame', async () => {
    const runner = new MockSimRunner();
    const tel = await runner.loadConfig(shortConfig());
    expect(tel.channels.map((c) => c.spec.kind)).toEqual(['client', 'envoy', 'backend']);
    expect(envoyRing(tel).size()).toBe(1);
    expect(await runner.status()).toMatchObject({ state: 'paused', virtualTimeMs: 0 });
  });

  it('steps one sample interval at a time and finishes at the end', async () => {
    const runner = new MockSimRunner();
    const tel = await runner.loadConfig(shortConfig());
    const ring = envoyRing(tel);
    await runner.step();
    expect((await runner.status()).virtualTimeMs).toBe(10);
    expect(ring.size()).toBe(2); // frame 0 + frame 10
    // Drain to the end.
    for (let t = 20; t <= 100; t += 10) await runner.step();
    expect((await runner.status()).state).toBe('finished');
    // A step past the end is a no-op that keeps the clock pinned to duration.
    await runner.step();
    expect(await runner.status()).toMatchObject({ state: 'finished', virtualTimeMs: 100 });
  });

  it('advances under play against the wall clock and finishes', async () => {
    const runner = new MockSimRunner();
    const tel = await runner.loadConfig(shortConfig());
    const ring = envoyRing(tel);
    await runner.play();
    expect(await runner.status()).toMatchObject({ state: 'running', speed: 1 });
    vi.advanceTimersByTime(64); // ticks at 16,32,48,64 → clock 64
    expect((await runner.status()).virtualTimeMs).toBe(64);
    vi.advanceTimersByTime(200); // run past the end
    const status = await runner.status();
    expect(status.state).toBe('finished');
    expect(status.virtualTimeMs).toBe(100);
    expect(ring.size()).toBe(11);
  });

  it('play is a no-op when already running or finished', async () => {
    const runner = new MockSimRunner();
    await runner.loadConfig(shortConfig());
    await runner.play();
    await runner.play(); // already running: no second timer
    vi.advanceTimersByTime(200);
    expect((await runner.status()).state).toBe('finished');
    await runner.play(); // finished: no-op
    expect((await runner.status()).state).toBe('finished');
  });

  it('pauses, stopping the clock', async () => {
    const runner = new MockSimRunner();
    await runner.loadConfig(shortConfig());
    await runner.play();
    vi.advanceTimersByTime(32);
    await runner.pause();
    const t = (await runner.status()).virtualTimeMs;
    expect(t).toBe(32);
    vi.advanceTimersByTime(80); // timer cleared: no advance
    expect((await runner.status()).virtualTimeMs).toBe(t);
    expect((await runner.status()).state).toBe('paused');
  });

  it('seeks: clamps, backfills a trailing window, and pins state', async () => {
    const runner = new MockSimRunner();
    const tel = await runner.loadConfig(shortConfig());
    const ring = envoyRing(tel);
    await runner.seek(55);
    expect(await runner.status()).toMatchObject({ state: 'paused', virtualTimeMs: 55 });
    // Frames 0..50 backfilled => 6 frames; latest stamped at 50.
    expect(ring.size()).toBe(6);
    expect(ring.latest()?.t).toBe(50);
    await runner.seek(-5);
    expect((await runner.status()).virtualTimeMs).toBe(0);
    await runner.seek(10_000);
    expect(await runner.status()).toMatchObject({ state: 'finished', virtualTimeMs: 100 });
  });

  it('validates and applies the speed multiplier', async () => {
    const runner = new MockSimRunner();
    await runner.loadConfig(shortConfig());
    await expect(runner.setSpeed(0)).rejects.toThrow(/> 0/);
    await runner.setSpeed(4);
    await runner.play();
    vi.advanceTimersByTime(16); // dt 16 * speed 4 = 64 virtual ms
    expect((await runner.status()).virtualTimeMs).toBe(64);
    await runner.setSpeed(2); // resets the wall baseline while running
    expect((await runner.status()).speed).toBe(2);
  });

  it('synthesizes a deterministic window aggregate', async () => {
    const runner = new MockSimRunner();
    await runner.loadConfig(shortConfig());
    const agg = await runner.queryWindow({ fromMs: 0, toMs: 1000 });
    expect(agg.totalRequests).toBeGreaterThan(0);
    expect(agg.completed + agg.timedOut + agg.rejected).toBe(agg.totalRequests);
    expect(agg.goodput).toBeGreaterThan(0);
    const empty = await runner.queryWindow({ fromMs: 500, toMs: 500 });
    expect(empty.totalRequests).toBe(0);
    expect(empty.goodput).toBe(1);
  });

  it('does not support inspection from the synthetic mock', async () => {
    const runner = new MockSimRunner();
    await runner.loadConfig(shortConfig());
    await expect(runner.requestInspection(0, 0)).rejects.toThrow(/inspection/);
  });

  describe('queryWindowLatencies', () => {
    it('returns ascending latencies with length <= 4000 and a boolean capped', async () => {
      const runner = new MockSimRunner();
      await runner.loadConfig(shortConfig());
      const result = await runner.queryWindowLatencies({ fromMs: 0, toMs: 1000 });
      expect(typeof result.capped).toBe('boolean');
      expect(result.latencies.length).toBeLessThanOrEqual(4000);
      // Every latency must be finite and non-negative.
      for (const v of result.latencies) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
      // Array must be ascending (sorted).
      for (let i = 1; i < result.latencies.length; i++) {
        expect(result.latencies[i]).toBeGreaterThanOrEqual(result.latencies[i - 1]!);
      }
    });

    it('echoes back fromMs and toMs', async () => {
      const runner = new MockSimRunner();
      await runner.loadConfig(shortConfig());
      const q = { fromMs: 100, toMs: 500 };
      const result = await runner.queryWindowLatencies(q);
      expect(result.fromMs).toBe(100);
      expect(result.toMs).toBe(500);
    });

    it('returns an empty array for a zero-span window', async () => {
      const runner = new MockSimRunner();
      await runner.loadConfig(shortConfig());
      const result = await runner.queryWindowLatencies({ fromMs: 500, toMs: 500 });
      expect(result.latencies).toHaveLength(0);
      expect(result.capped).toBe(false);
    });

    it('is deterministic: same query produces the same result', async () => {
      const runner = new MockSimRunner();
      await runner.loadConfig(shortConfig());
      const a = await runner.queryWindowLatencies({ fromMs: 0, toMs: 1000 });
      const b = await runner.queryWindowLatencies({ fromMs: 0, toMs: 1000 });
      expect(a.latencies).toEqual(b.latencies);
    });
  });

  it('ignores a stray tick once stopped (defensive guard)', async () => {
    const runner = new MockSimRunner();
    await runner.loadConfig(shortConfig());
    // Paused after load: a direct onTick must not advance the clock.
    (runner as unknown as { onTick(w: number): void }).onTick(999);
    expect((await runner.status()).virtualTimeMs).toBe(0);
  });

  it('reloading after a run stops the prior timer', async () => {
    const runner = new MockSimRunner();
    await runner.loadConfig(shortConfig());
    await runner.play();
    await runner.loadConfig(shortConfig()); // must clear the running timer
    expect((await runner.status()).state).toBe('paused');
    runner.dispose();
  });
});
