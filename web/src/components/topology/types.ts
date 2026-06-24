import type { EntityKind } from '@elbsim/protocol';

/** One entity's live status as the topology graph renders it. */
export interface TopologyNodeStatus {
  kind: EntityKind;
  index: number;
  label: string;
  /** Active in-flight requests at the node. */
  inFlight: number;
  /** Pending admission/queue depth. */
  queueDepth: number;
  /** Queue capacity (the denominator for the queue bar); 0 if not queued. */
  queueCapacity: number;
  /** Load in [0,1]: inFlight / capacity (backends) or / maxConcurrent (envoys). */
  utilization: number;
  /**
   * Health ordinal. Backends use the `BackendHealth` order (0 healthy .. 3
   * draining) to match the `backend.health` gauge; clients/envoys are always 0.
   */
  health: 0 | 1 | 2 | 3;
  /** Envoy priority-set panic mode (always false for clients/backends). */
  panic: boolean;
  region: string;
  zone: string;
}

/** A directed traffic edge with its relative share for stroke weighting. */
export interface TopologyEdge {
  fromKind: EntityKind;
  fromIndex: number;
  toKind: EntityKind;
  toIndex: number;
  /** Relative traffic share in [0,1], used to weight the edge stroke. */
  share: number;
}

/** A full topology snapshot at one virtual instant. */
export interface TopologySnapshot {
  t: number;
  clients: TopologyNodeStatus[];
  envoys: TopologyNodeStatus[];
  backends: TopologyNodeStatus[];
  edges: TopologyEdge[];
}
