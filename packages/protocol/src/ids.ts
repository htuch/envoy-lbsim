/**
 * Stable identity for simulated entities. Ids are dense, zero-based indices
 * within their kind (client 0..M-1, envoy 0..N-1, backend 0..P-1) so they can
 * double as array offsets in the hot-path ring buffers.
 */

export type ClientId = number;
export type EnvoyId = number;
export type BackendId = number;
export type RequestId = number;

export const ENTITY_KINDS = ['client', 'envoy', 'backend'] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/** A fully-qualified entity reference (kind + index). */
export interface EntityRef {
  kind: EntityKind;
  index: number;
}
