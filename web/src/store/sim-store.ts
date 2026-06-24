import { defaultSimConfig, type SimConfig } from '@elbsim/config';
import {
  type EntityKind,
  GaugeRingBuffer,
  type LbInspection,
  type RunStatus,
  type SharedTelemetry,
  type SimWorkerApi,
  type WindowAggregate,
  type WindowLatencySamples,
  type WindowQuery,
} from '@elbsim/protocol';
import { create } from 'zustand';

/**
 * A committed x-window (virtual ms) selected by brushing a timeline. Shared by
 * every strip so zoom is lock-step across gauges, and handed to the cold path
 * (Track D's `queryWindow`). `null` means "no selection": follow the live range.
 */
export type TimelineSelection = WindowQuery | null;

/**
 * The single client-side store. It owns the active config, the playback status
 * mirrored from the worker, and the read-side ring buffers over the shared
 * telemetry. The 60fps hot path does NOT live here: timeline components read the
 * {@link GaugeRingBuffer}s directly each frame. The store carries low-frequency
 * control state (status, config) that React renders, plus the transport actions
 * that proxy to the worker.
 */

export interface SimStore {
  /** The worker proxy; null until {@link attach}ed (injected for tests). */
  api: SimWorkerApi | null;
  /** The active configuration; the editor mutates this draft, `load` applies it. */
  config: SimConfig;
  /** Playback status, mirrored from the worker on each control action / tick. */
  status: RunStatus;
  /** Read views over the shared telemetry, one per entity kind. */
  rings: Map<EntityKind, GaugeRingBuffer>;
  /** True once a config has been loaded and telemetry buffers exist. */
  ready: boolean;
  /** The committed brushed x-window shared across all timelines (null = live). */
  selection: TimelineSelection;

  /** The currently selected Envoy replica index (0-based). */
  selectedEnvoy: number;

  /**
   * Monotonically-bumped version integer. Incremented on every {@link load} so
   * in-flight async reads against the old run can be identified and dropped.
   */
  handle: number;

  /** Cold-path window aggregate; null while no window is committed or loading. */
  windowAggregate: WindowAggregate | null;
  /** Cold-path per-request latency samples; null while no window is committed or loading. */
  windowSamples: WindowLatencySamples | null;
  /** True while a {@link loadWindow} call is outstanding. */
  windowLoading: boolean;

  /** Most recently committed LB inspection; null until first fetch. */
  inspection: LbInspection | null;
  /** True while a {@link loadInspection} call is outstanding. */
  inspectionLoading: boolean;

  /**
   * Monotonic sequence counter for in-flight inspection requests. Lives in
   * store state (not a module global) so concurrent tests do not interfere.
   */
  inspectReqSeq: number;

  attach: (api: SimWorkerApi) => void;
  /** Load a config (defaults to the current draft) and prepare a fresh run. */
  load: (config?: SimConfig) => Promise<void>;
  play: () => Promise<void>;
  pause: () => Promise<void>;
  step: () => Promise<void>;
  seek: (tMs: number) => Promise<void>;
  setSpeed: (multiplier: number) => Promise<void>;
  /** Pull the authoritative status from the worker (called on a low-rate tick). */
  syncStatus: () => Promise<void>;
  /** Replace the active config draft without reloading (the editor uses this). */
  setConfig: (config: SimConfig) => void;
  /** Commit (or clear, with `null`) the shared brushed window. */
  setSelection: (selection: TimelineSelection) => void;
  /** Update the selected Envoy replica index. */
  setSelectedEnvoy: (i: number) => void;
  /**
   * Fetch window aggregate and latency samples for the given query in parallel.
   * Drops the result if the run handle changed (a `load()` happened mid-flight).
   */
  loadWindow: (q: WindowQuery) => Promise<void>;
  /**
   * Fetch an LB inspection snapshot for the given Envoy at the given virtual
   * time. Only the latest in-flight request commits; earlier superseded
   * responses are silently discarded.
   */
  loadInspection: (envoy: number, tMs: number) => Promise<void>;
}

const IDLE_STATUS: RunStatus = { state: 'idle', virtualTimeMs: 0, speed: 0 };

/** Build read-side ring buffers over the worker's shared telemetry handles. */
function ringsFromTelemetry(telemetry: SharedTelemetry): Map<EntityKind, GaugeRingBuffer> {
  const rings = new Map<EntityKind, GaugeRingBuffer>();
  for (const ch of telemetry.channels) {
    rings.set(
      ch.spec.kind,
      new GaugeRingBuffer(
        ch.spec,
        new Int32Array(ch.control),
        new Float64Array(ch.time),
        new Float32Array(ch.data),
      ),
    );
  }
  return rings;
}

export const useSimStore = create<SimStore>((set, get) => ({
  api: null,
  config: defaultSimConfig(),
  status: IDLE_STATUS,
  rings: new Map(),
  ready: false,
  selection: null,
  selectedEnvoy: 0,
  handle: 0,
  windowAggregate: null,
  windowSamples: null,
  windowLoading: false,
  inspection: null,
  inspectionLoading: false,
  inspectReqSeq: 0,

  attach: (api) => set({ api }),

  load: async (config) => {
    const { api, config: draft } = get();
    if (!api) throw new Error('store is not attached to a worker');
    const next = config ?? draft;
    const telemetry = await api.loadConfig(next);
    // A fresh run invalidates any prior brushed window and all caches.
    set({
      config: next,
      rings: ringsFromTelemetry(telemetry),
      ready: true,
      selection: null,
      handle: get().handle + 1,
      windowAggregate: null,
      windowSamples: null,
      inspection: null,
    });
    await get().syncStatus();
  },

  play: async () => {
    const { api } = get();
    if (!api) return;
    await api.play();
    await get().syncStatus();
  },

  pause: async () => {
    const { api } = get();
    if (!api) return;
    await api.pause();
    await get().syncStatus();
  },

  step: async () => {
    const { api } = get();
    if (!api) return;
    await api.step();
    await get().syncStatus();
  },

  seek: async (tMs) => {
    const { api } = get();
    if (!api) return;
    await api.seek(tMs);
    await get().syncStatus();
  },

  setSpeed: async (multiplier) => {
    const { api } = get();
    if (!api) return;
    await api.setSpeed(multiplier);
    await get().syncStatus();
  },

  syncStatus: async () => {
    const { api } = get();
    if (!api) return;
    set({ status: await api.status() });
  },

  setConfig: (config) => set({ config }),

  setSelection: (selection) => set({ selection }),

  setSelectedEnvoy: (i) => set({ selectedEnvoy: i }),

  loadWindow: async (q) => {
    const { api } = get();
    if (!api) return;
    const capturedHandle = get().handle;
    set({ windowLoading: true });
    try {
      const [agg, samples] = await Promise.all([api.queryWindow(q), api.queryWindowLatencies(q)]);
      // Drop stale: the run was reloaded while we were in-flight.
      if (get().handle !== capturedHandle) return;
      set({ windowAggregate: agg, windowSamples: samples });
    } finally {
      // Only clear the loading flag if we are still the current run.
      if (get().handle === capturedHandle) {
        set({ windowLoading: false });
      }
    }
  },

  loadInspection: async (envoy, tMs) => {
    const { api } = get();
    if (!api) return;
    // Bump the sequence counter and capture this request's id.
    const mySeq = get().inspectReqSeq + 1;
    set({ inspectReqSeq: mySeq, inspectionLoading: true });
    try {
      const result = await api.requestInspection(envoy, tMs);
      // Only commit if no newer request has been issued since we started.
      if (get().inspectReqSeq !== mySeq) return;
      set({ inspection: result });
    } finally {
      if (get().inspectReqSeq === mySeq) {
        set({ inspectionLoading: false });
      }
    }
  },
}));
