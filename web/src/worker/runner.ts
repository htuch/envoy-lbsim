import type { SimConfig } from '@elbsim/config';
import {
  type EnvoyId,
  GaugeRingBuffer,
  type LbInspection,
  type PlaybackState,
  type RingBufferSpec,
  type RunStatus,
  ringByteLengths,
  type SharedTelemetry,
  type SimWorkerApi,
  type WindowAggregate,
  type WindowLatencySamples,
  type WindowQuery,
} from '@elbsim/protocol';
import { channelSpecs, SyntheticModel } from './synthetic';

/**
 * The synthetic simulation worker. It implements the real {@link SimWorkerApi}
 * over the {@link SyntheticModel}, so Track B's kernel-backed worker is a
 * drop-in replacement: allocate one SharedArrayBuffer-backed ring per entity
 * kind, hand the buffers back, and pace deterministic frames into them under
 * play/pause/step/seek/speed control.
 *
 * Time advances against the wall clock (scaled by `speed`) only to pace the UI;
 * the *values* are pure in virtual time, so a seek reproduces identical frames
 * and the run is reproducible from `config.seed` regardless of frame timing.
 */

/** Default tick cadence of the play loop (wall ms). */
export const TICK_MS = 16;

/** Hard cap on retained frames so a long run cannot allocate an unbounded ring. */
export const MAX_CAPACITY = 6_000;

interface Channel {
  spec: RingBufferSpec;
  ring: GaugeRingBuffer;
  control: Int32Array;
  scratch: Float32Array;
}

/** Frames retained for a run: the whole run when short, capped otherwise. */
export function runCapacity(config: SimConfig): number {
  const frames = Math.floor(config.time.durationMs / config.time.sampleIntervalMs) + 1;
  return Math.min(Math.max(frames, 1), MAX_CAPACITY);
}

export class MockSimRunner implements SimWorkerApi {
  private config?: SimConfig;
  private model?: SyntheticModel;
  private channels: Channel[] = [];
  private state: PlaybackState = 'idle';
  private clock = 0;
  private speed = 1;
  private nextFrameMs = 0;
  private lastWallMs = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  async loadConfig(config: SimConfig): Promise<SharedTelemetry> {
    this.stopTimer();
    this.config = config;
    this.model = new SyntheticModel(config, config.seed);
    const capacity = runCapacity(config);
    const specs = channelSpecs(config, capacity);
    const telemetry: SharedTelemetry = { channels: [] };
    this.channels = specs.map((spec) => {
      const sizes = ringByteLengths(spec);
      const control = new SharedArrayBuffer(sizes.control);
      const time = new SharedArrayBuffer(sizes.time);
      const data = new SharedArrayBuffer(sizes.data);
      const controlView = new Int32Array(control);
      const ring = new GaugeRingBuffer(
        spec,
        controlView,
        new Float64Array(time),
        new Float32Array(data),
      );
      telemetry.channels.push({ spec, control, time, data });
      return { spec, ring, control: controlView, scratch: new Float32Array(ring.stride) };
    });
    this.state = 'paused';
    this.clock = 0;
    this.speed = 1;
    // Seed the t=0 frame so the views are non-empty before the first play, then
    // point the cursor at the next due frame.
    this.pushFrame(0);
    this.nextFrameMs = config.time.sampleIntervalMs;
    return telemetry;
  }

  async play(): Promise<void> {
    this.requireLoaded();
    if (this.state === 'finished' || this.state === 'running') return;
    this.state = 'running';
    this.lastWallMs = this.wallNow();
    this.timer = setInterval(() => this.onTick(this.wallNow()), TICK_MS);
  }

  async pause(): Promise<void> {
    this.requireLoaded();
    this.stopTimer();
    if (this.state === 'running') this.state = 'paused';
  }

  async step(): Promise<void> {
    this.requireLoaded();
    this.stopTimer();
    const duration = this.duration();
    if (this.nextFrameMs > duration) {
      this.state = 'finished';
      this.clock = duration;
      return;
    }
    const t = this.nextFrameMs;
    this.pushFrame(t);
    this.nextFrameMs += this.interval();
    this.clock = t;
    this.state = t >= duration ? 'finished' : 'paused';
  }

  async seek(tMs: number): Promise<void> {
    this.requireLoaded();
    this.stopTimer();
    const duration = this.duration();
    const t = tMs < 0 ? 0 : tMs > duration ? duration : tMs;
    this.backfill(t);
    this.clock = t;
    this.state = t >= duration ? 'finished' : 'paused';
  }

  async setSpeed(multiplier: number): Promise<void> {
    if (!(multiplier > 0)) throw new Error('speed multiplier must be > 0');
    this.speed = multiplier;
    if (this.state === 'running') this.lastWallMs = this.wallNow();
  }

  async status(): Promise<RunStatus> {
    return {
      state: this.state,
      virtualTimeMs: this.clock,
      speed: this.state === 'running' ? this.speed : 0,
    };
  }

  async queryWindow(q: WindowQuery): Promise<WindowAggregate> {
    this.requireLoaded();
    const config = this.config as SimConfig;
    const span = Math.max(0, q.toMs - q.fromMs);
    // Synthetic, deterministic aggregate: emitted ~ fleet rate over the window.
    const emitted = Math.round(
      (config.clients.count * config.clients.arrival.ratePerSec * span) / 1_000,
    );
    const timedOut = Math.round(emitted * 0.01);
    const rejected = Math.round(emitted * 0.005);
    const completed = Math.max(0, emitted - timedOut - rejected);
    return {
      fromMs: q.fromMs,
      toMs: q.toMs,
      totalRequests: emitted,
      completed,
      timedOut,
      rejected,
      goodput: emitted === 0 ? 1 : completed / emitted,
      latencyP50: 12,
      latencyP90: 38,
      latencyP99: 92,
    };
  }

  async queryWindowLatencies(q: WindowQuery): Promise<WindowLatencySamples> {
    this.requireLoaded();
    const n = Math.min(2000, this.windowSampleCount(q));
    const latencies = Array.from({ length: n }, (_, i) =>
      this.sampleLatency(i / Math.max(1, n - 1)),
    );
    latencies.sort((a, b) => a - b);
    return { fromMs: q.fromMs, toMs: q.toMs, latencies, capped: false };
  }

  async requestInspection(_envoy: EnvoyId, _tMs: number): Promise<LbInspection> {
    // Inspection is real-Wasm deterministic replay (Track A serializes, Track D
    // renders); the synthetic mock has no LB structures to serialize.
    throw new Error('inspection is not available from the synthetic mock worker');
  }

  /** Stop the play loop and release any resources tied to the current run. */
  dispose(): void {
    this.stopTimer();
  }

  // --- internals -------------------------------------------------------------

  /** Wall clock used only to pace playback; values stay pure in virtual time. */
  private wallNow(): number {
    return performance.now();
  }

  private duration(): number {
    return (this.config as SimConfig).time.durationMs;
  }

  private interval(): number {
    return (this.config as SimConfig).time.sampleIntervalMs;
  }

  private requireLoaded(): void {
    if (this.config === undefined) throw new Error('loadConfig must be called first');
  }

  private stopTimer(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Advance the virtual clock to match elapsed wall time, emitting due frames. */
  private onTick(wallNowMs: number): void {
    if (this.state !== 'running') return;
    const duration = this.duration();
    const dt = wallNowMs - this.lastWallMs;
    this.lastWallMs = wallNowMs;
    let next = this.clock + dt * this.speed;
    if (next >= duration) next = duration;
    this.emitFramesUpTo(next);
    this.clock = next;
    if (next >= duration) {
      this.state = 'finished';
      this.stopTimer();
    }
  }

  /** Push every due frame whose timestamp is <= `t` (and within the run). */
  private emitFramesUpTo(t: number): void {
    const duration = this.duration();
    const interval = this.interval();
    while (this.nextFrameMs <= t && this.nextFrameMs <= duration) {
      this.pushFrame(this.nextFrameMs);
      this.nextFrameMs += interval;
    }
  }

  /** Clear the rings and refill the trailing window ending at virtual time `t`. */
  private backfill(t: number): void {
    const interval = this.interval();
    for (const ch of this.channels) {
      ch.control[0] = 0;
      ch.control[1] = 0;
    }
    const lastBoundary = Math.floor(t / interval) * interval;
    const capacity = runCapacity(this.config as SimConfig);
    const firstBoundary = Math.max(0, lastBoundary - (capacity - 1) * interval);
    for (let tt = firstBoundary; tt <= lastBoundary; tt += interval) {
      this.pushFrame(tt);
    }
    this.nextFrameMs = lastBoundary + interval;
  }

  /** Write one frame across every channel at virtual time `t`. */
  private pushFrame(t: number): void {
    const model = this.model as SyntheticModel;
    for (const ch of this.channels) {
      model.fillFrame(ch.spec.kind, t, ch.scratch);
      ch.ring.push(t, ch.scratch);
    }
  }

  /**
   * Number of synthetic samples for a window, derived from the same fleet-rate
   * math that `queryWindow` uses for its `emitted` count.
   */
  private windowSampleCount(q: WindowQuery): number {
    const config = this.config as SimConfig;
    const span = Math.max(0, q.toMs - q.fromMs);
    return Math.round((config.clients.count * config.clients.arrival.ratePerSec * span) / 1_000);
  }

  /**
   * Map a unit-interval quantile `u` in [0,1] to a plausible latency (ms)
   * consistent with the mock's fixed percentiles: P50=12, P90=38, P99=92.
   *
   * Uses piecewise linear interpolation across the anchor points
   * (0,0), (0.5,12), (0.9,38), (0.99,92), (1.0,150) so the resulting
   * sorted array will match those percentiles when queried.
   */
  private sampleLatency(u: number): number {
    // Anchor: [quantile, latencyMs]
    const anchors: [number, number][] = [
      [0, 0],
      [0.5, 12],
      [0.9, 38],
      [0.99, 92],
      [1.0, 150],
    ];
    for (let i = 1; i < anchors.length; i++) {
      const [q0, v0] = anchors[i - 1]!;
      const [q1, v1] = anchors[i]!;
      if (u <= q1) {
        const t = q1 === q0 ? 0 : (u - q0) / (q1 - q0);
        return v0 + t * (v1 - v0);
      }
    }
    return 150;
  }
}
