import { defaultSimConfig, type SimConfig } from '@elbsim/config';
import {
  type EntityKind,
  GaugeRingBuffer,
  type RunStatus,
  type SharedTelemetry,
  type SimWorkerApi,
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

  attach: (api) => set({ api }),

  load: async (config) => {
    const { api, config: draft } = get();
    if (!api) throw new Error('store is not attached to a worker');
    const next = config ?? draft;
    const telemetry = await api.loadConfig(next);
    // A fresh run invalidates any prior brushed window.
    set({ config: next, rings: ringsFromTelemetry(telemetry), ready: true, selection: null });
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
}));
