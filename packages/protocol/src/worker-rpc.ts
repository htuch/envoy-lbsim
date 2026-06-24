import type { SimConfig } from '@elbsim/config';
import type { EnvoyId } from './ids';
import type { LbInspection } from './inspection';
import type { RingBufferSpec } from './snapshots';

/**
 * Control-plane RPC between the main thread and the simulation Web Worker,
 * exposed via Comlink. The hot data path does NOT go through here; gauges flow
 * through the shared ring buffers (see `snapshots.ts`); this surface is for
 * setup, playback control, and on-demand queries.
 */

export type PlaybackState = 'idle' | 'running' | 'paused' | 'finished';

/** Handles to the shared buffers a run exposes, plus their layout specs. */
export interface SharedTelemetry {
  /** One ring buffer per entity kind, as a SharedArrayBuffer + its spec. */
  channels: Array<{
    spec: RingBufferSpec;
    control: SharedArrayBuffer;
    time: SharedArrayBuffer;
    data: SharedArrayBuffer;
  }>;
}

/** Snapshot of playback status, pushed to subscribers on change. */
export interface RunStatus {
  state: PlaybackState;
  /** Current virtual time (ms). */
  virtualTimeMs: number;
  /** Playback speed multiplier (virtual ms per wall ms); 0 while paused. */
  speed: number;
}

/** Aggregates over a committed time window, for the cold-path analytical views. */
export interface WindowQuery {
  fromMs: number;
  toMs: number;
}

export interface WindowAggregate {
  fromMs: number;
  toMs: number;
  totalRequests: number;
  completed: number;
  timedOut: number;
  rejected: number;
  /** Goodput = completed within timeout / total emitted, in [0,1]. */
  goodput: number;
  /** Latency percentiles (ms) over completed requests in the window. */
  latencyP50: number;
  latencyP90: number;
  latencyP99: number;
}

/** Per-request latency samples over a committed window, for the cold-path charts. */
export interface WindowLatencySamples {
  fromMs: number;
  toMs: number;
  /** Ascending completed-request latencies (ms), downsampled to a bounded size. */
  latencies: number[];
  /** True if the cohort was larger than the cap and was downsampled. */
  capped: boolean;
}

/** The Comlink-exposed worker API. All methods are async across the boundary. */
export interface SimWorkerApi {
  /** Load a config and prepare a run; returns the shared telemetry handles. */
  loadConfig(config: SimConfig): Promise<SharedTelemetry>;
  play(): Promise<void>;
  pause(): Promise<void>;
  /** Advance exactly one sample interval and stop. */
  step(): Promise<void>;
  /** Jump the virtual clock to `tMs` (re-simulating deterministically as needed). */
  seek(tMs: number): Promise<void>;
  /** Set the playback speed multiplier. */
  setSpeed(multiplier: number): Promise<void>;
  status(): Promise<RunStatus>;
  /** Compute cold-path aggregates over a committed window. */
  queryWindow(q: WindowQuery): Promise<WindowAggregate>;
  /** Latency samples over a committed window (CDF/histogram source). */
  queryWindowLatencies(q: WindowQuery): Promise<WindowLatencySamples>;
  /** Serialize an Envoy's internal LB structures at a virtual instant. */
  requestInspection(envoy: EnvoyId, tMs: number): Promise<LbInspection>;
}
