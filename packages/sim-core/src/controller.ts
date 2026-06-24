import type { SimConfig } from '@elbsim/config';
import {
  type EntityKind,
  type EnvoyId,
  GaugeRingBuffer,
  type LbInspection,
  type LbModule,
  type PlaybackState,
  type RequestEvent,
  type RunStatus,
  ringByteLengths,
  type SharedTelemetry,
  type SimWorkerApi,
} from '@elbsim/protocol';
import { ringSpecs, SimEngine } from './engine';

/**
 * The worker-side implementation of {@link SimWorkerApi} (Track B). It owns the
 * live {@link SimEngine}, drives playback, and answers cold-path queries. The
 * Comlink transport and the SharedArrayBuffer plumbing on the main thread are
 * Track C; this class is the deterministic core behind that boundary and is
 * fully usable (and testable) in-process.
 *
 * Gauge frames are written into SharedArrayBuffer-backed ring buffers handed
 * back from {@link loadConfig}. Playback advances virtual time in fixed wall
 * ticks; a backwards seek re-simulates from the seed into the same buffers
 * (the run is a pure function of the config). Cold-path aggregates and
 * inspection use independent fully-drained replays so they never disturb the
 * live timeline.
 */

/** Wall-clock cadence (ms) of one playback tick; virtual advance = speed * this. */
const FRAME_MS = 16;

/** Drives playback ticks; injectable so playback is deterministic under test. */
export interface Ticker {
  start(onTick: () => void): void;
  stop(): void;
}

// Host timer functions (present in workers, browsers, and node) reached without
// pulling DOM/node lib typings into this package.
const timers = globalThis as unknown as {
  setInterval(cb: () => void, ms: number): number;
  clearInterval(handle: number): void;
};

/** Default ticker: a real wall-clock interval. */
class IntervalTicker implements Ticker {
  private handle: number | undefined;
  start(onTick: () => void): void {
    this.stop();
    this.handle = timers.setInterval(onTick, FRAME_MS);
  }
  stop(): void {
    if (this.handle !== undefined) timers.clearInterval(this.handle);
    this.handle = undefined;
  }
}

export interface SimControllerOptions {
  lbModule?: LbModule;
  ticker?: Ticker;
}

export class SimController implements SimWorkerApi {
  private readonly lbModule: LbModule | undefined;
  private readonly ticker: Ticker;

  private config: SimConfig | undefined;
  private engine: SimEngine | undefined;
  private buffers: Record<EntityKind, GaugeRingBuffer> | undefined;
  private analysisEvents: readonly RequestEvent[] | undefined;
  private state: PlaybackState = 'idle';
  private vt = 0;
  private speed = 1;
  private horizon = 0;
  private interval = 0;

  constructor(opts: SimControllerOptions = {}) {
    this.lbModule = opts.lbModule;
    this.ticker = opts.ticker ?? new IntervalTicker();
  }

  async loadConfig(config: SimConfig): Promise<SharedTelemetry> {
    this.ticker.stop();
    this.config = config;
    this.horizon = config.time.durationMs;
    this.interval = config.time.sampleIntervalMs;
    this.speed = 1;
    this.vt = 0;
    this.state = 'idle';
    this.analysisEvents = undefined;

    const specs = ringSpecs(config);
    const channels: SharedTelemetry['channels'] = [];
    const buffers = {} as Record<EntityKind, GaugeRingBuffer>;
    for (const kind of ['client', 'envoy', 'backend'] as const) {
      const spec = specs[kind];
      const lens = ringByteLengths(spec);
      const control = new SharedArrayBuffer(lens.control);
      const time = new SharedArrayBuffer(lens.time);
      const data = new SharedArrayBuffer(lens.data);
      buffers[kind] = new GaugeRingBuffer(
        spec,
        new Int32Array(control),
        new Float64Array(time),
        new Float32Array(data),
      );
      channels.push({ spec, control, time, data });
    }
    this.buffers = buffers;
    this.engine = this.buildEngine(buffers);
    return { channels };
  }

  async play(): Promise<void> {
    if (this.state === 'finished') return;
    this.state = 'running';
    this.ticker.start(() => this.advance(this.speed * FRAME_MS));
  }

  async pause(): Promise<void> {
    this.ticker.stop();
    if (this.state !== 'finished') this.state = 'paused';
  }

  async step(): Promise<void> {
    this.ticker.stop();
    this.advance(this.interval);
    if (this.state !== 'finished') this.state = 'paused';
  }

  async seek(tMs: number): Promise<void> {
    this.ticker.stop();
    const target = clamp(tMs, 0, this.horizon);
    if (target < this.vt) {
      // Re-simulate from the seed into the same buffers. A backward seek implies
      // vt > 0, which only happens after loadConfig, so buffers is set.
      const buffers = this.buffers as Record<EntityKind, GaugeRingBuffer>;
      for (const kind of ['client', 'envoy', 'backend'] as const) buffers[kind].reset();
      this.engine = this.buildEngine(buffers);
      this.vt = 0;
    }
    this.requireEngine().runUntil(target);
    this.vt = target;
    this.state = target >= this.horizon ? 'finished' : 'paused';
  }

  async setSpeed(multiplier: number): Promise<void> {
    this.speed = multiplier;
  }

  async status(): Promise<RunStatus> {
    return {
      state: this.state,
      virtualTimeMs: this.vt,
      speed: this.state === 'running' ? this.speed : 0,
    };
  }

  async queryWindow(q: { fromMs: number; toMs: number }) {
    // Cohort-based: select the requests *emitted* in the window, then attribute
    // each by its terminal outcome wherever it resolved. This matches the
    // contract ("completed within timeout / total emitted") and avoids
    // understating goodput at the window's trailing edge, where in-window
    // emissions complete a few ms later.
    const events = this.fullRun();
    const cohort = new Set<number>();
    const completedLatency = new Map<number, number>();
    const terminal = new Map<number, RequestEvent['phase']>();
    for (const e of events) {
      if (e.phase === 'emitted' && e.t >= q.fromMs && e.t <= q.toMs) cohort.add(e.req);
      if (e.phase === 'completed') {
        completedLatency.set(e.req, e.latencyMs);
        terminal.set(e.req, 'completed');
      } else if (e.phase === 'timed_out' || e.phase === 'rejected') {
        terminal.set(e.req, e.phase);
      }
    }

    let completed = 0;
    let timedOut = 0;
    let rejected = 0;
    const latencies: number[] = [];
    for (const req of cohort) {
      switch (terminal.get(req)) {
        case 'completed':
          completed++;
          latencies.push(completedLatency.get(req) as number);
          break;
        case 'timed_out':
          timedOut++;
          break;
        case 'rejected':
          rejected++;
          break;
      }
    }
    latencies.sort((a, b) => a - b);
    const totalRequests = cohort.size;
    return {
      fromMs: q.fromMs,
      toMs: q.toMs,
      totalRequests,
      completed,
      timedOut,
      rejected,
      goodput: totalRequests === 0 ? 0 : clamp(completed / totalRequests, 0, 1),
      latencyP50: percentile(latencies, 0.5),
      latencyP90: percentile(latencies, 0.9),
      latencyP99: percentile(latencies, 0.99),
    };
  }

  async requestInspection(envoy: EnvoyId, tMs: number): Promise<LbInspection> {
    // A throwaway replay to the requested instant; never touches live state.
    const engine = this.buildEngine();
    engine.runUntil(clamp(tMs, 0, this.horizon));
    return engine.inspect(envoy);
  }

  // --- internals ---------------------------------------------------------

  private advance(deltaVirtual: number): void {
    const target = Math.min(this.horizon, this.vt + deltaVirtual);
    this.requireEngine().runUntil(target);
    this.vt = target;
    if (this.vt >= this.horizon) {
      this.state = 'finished';
      this.ticker.stop();
    }
  }

  private buildEngine(channels?: Record<EntityKind, GaugeRingBuffer>): SimEngine {
    const opts: { lbModule?: LbModule; channels?: Record<EntityKind, GaugeRingBuffer> } = {};
    if (this.lbModule) opts.lbModule = this.lbModule;
    if (channels) opts.channels = channels;
    return new SimEngine(this.requireConfig(), opts);
  }

  /** Lazily build and cache a fully-drained run for cold-path aggregates. */
  private fullRun(): readonly RequestEvent[] {
    if (!this.analysisEvents) {
      const engine = this.buildEngine();
      engine.runToCompletion();
      this.analysisEvents = engine.events;
    }
    return this.analysisEvents;
  }

  private requireConfig(): SimConfig {
    if (!this.config) throw new Error('loadConfig has not been called');
    return this.config;
  }

  private requireEngine(): SimEngine {
    if (!this.engine) throw new Error('loadConfig has not been called');
    return this.engine;
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** Linear-interpolated percentile over an ascending-sorted array; 0 if empty. */
function percentile(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const rank = q * (n - 1); // n === 1 collapses to index 0
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const frac = rank - lo;
  return (sorted[lo] as number) * (1 - frac) + (sorted[hi] as number) * frac;
}
