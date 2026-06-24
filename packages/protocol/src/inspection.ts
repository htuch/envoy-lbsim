import type { EnvoyLbPolicyKind } from '@elbsim/config';
import type { BackendId, EnvoyId } from './ids';

/**
 * LB data-structure inspection payload.
 *
 * The signature feature: clicking an Envoy at a point in virtual time and
 * traversing the *real* internal LB structures held in Wasm memory. The Wasm
 * module serializes its live structures (EDF heap, Maglev table, hash ring) into
 * one of these plain views, which the inspector UI renders. This is the durable
 * contract between the Wasm serializer (Track A) and the inspector (Track D).
 */

/** One host as the LB currently sees it (post health/weight resolution). */
export interface InspectedHost {
  backend: BackendId;
  weight: number;
  /** 0 unhealthy, 1 degraded, 2 healthy (Envoy Host::Health ordinal). */
  health: 0 | 1 | 2;
  priority: number;
  region: string;
  zone: string;
  activeRequests: number;
}

/** EDF scheduler state (round_robin / least_request weighted path). */
export interface EdfInspection {
  kind: 'edf';
  /** The scheduler's virtual clock (`current_time_`). */
  currentTime: number;
  /** Min-heap entries by ascending deadline (the next pick is entry 0). */
  entries: Array<{ backend: BackendId; deadline: number; weight: number }>;
  /** Hosts handled by the fast unweighted path, if any. */
  prepick: BackendId[];
}

/** Maglev lookup table state. */
export interface MaglevInspection {
  kind: 'maglev';
  tableSize: number;
  /** Per-slot backend index; length === tableSize. */
  table: Uint32Array;
  /** Realized slot share per backend (for a quick fairness read-out). */
  slotCounts: Record<BackendId, number>;
}

/** Consistent-hash ring state. */
export interface RingHashInspection {
  kind: 'ring';
  size: number;
  /** Ring points sorted ascending by hash. */
  entries: Array<{ hash: string; backend: BackendId }>;
}

/** Policies with no persistent structure (random). */
export interface StatelessInspection {
  kind: 'none';
}

export type LbStructure =
  | EdfInspection
  | MaglevInspection
  | RingHashInspection
  | StatelessInspection;

/** A full inspection snapshot for one Envoy replica at one virtual instant. */
export interface LbInspection {
  envoy: EnvoyId;
  t: number;
  policy: EnvoyLbPolicyKind;
  /** Panic-mode and priority context at the time of inspection. */
  panic: boolean;
  hosts: InspectedHost[];
  structure: LbStructure;
}
