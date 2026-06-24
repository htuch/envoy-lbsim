import type { MaglevInspection, RingHashInspection } from '@elbsim/protocol';

/**
 * Pure transforms that prepare LB structures for rendering: downsampling a large
 * Maglev table to a drawable strip, mapping ring hashes to angular positions,
 * and tallying per-backend shares. Kept DOM-free so the math is unit-testable.
 */

/**
 * Reduce a Maglev table to at most `buckets` evenly-spaced slot samples (the
 * real table is up to ~65537 slots; the strip renders a few hundred). Returns
 * the per-bucket backend index.
 */
export function downsampleTable(table: Uint32Array, buckets: number): number[] {
  const n = table.length;
  if (n <= buckets) return Array.from(table);
  const out: number[] = [];
  for (let i = 0; i < buckets; i++) {
    out.push(table[Math.round((i * (n - 1)) / (buckets - 1))]!);
  }
  return out;
}

/** Map a 64-bit hex ring hash to a fraction of the ring in [0,1). */
export function hashFraction(hash: string): number {
  // Top 32 bits are enough to place a tick; full 64 bits exceed Number precision.
  return Number.parseInt(hash.slice(0, 8), 16) / 0x1_0000_0000;
}

export interface RingPoint {
  /** Stable, unique render key for this tick (positional, never reordered). */
  id: string;
  fraction: number;
  backend: number;
}

/**
 * Ring points as angular fractions, downsampled to at most `maxPoints` evenly
 * across the (already hash-sorted) ring so a dense ring stays drawable. Each
 * point carries a stable id so the view keys ticks without an array index.
 */
export function ringPoints(ring: RingHashInspection, maxPoints: number): RingPoint[] {
  const entries = ring.entries;
  const toPoint = (e: { hash: string; backend: number }, i: number): RingPoint => ({
    id: `${i}`,
    fraction: hashFraction(e.hash),
    backend: e.backend,
  });
  if (entries.length <= maxPoints) return entries.map(toPoint);
  const out: RingPoint[] = [];
  for (let i = 0; i < maxPoints; i++) {
    out.push(toPoint(entries[Math.floor((i * entries.length) / maxPoints)]!, i));
  }
  return out;
}

export interface SlotShare {
  backend: number;
  count: number;
  /** Fraction of the table held by this backend, in [0,1]. */
  fraction: number;
}

/** Per-backend Maglev slot shares, sorted by backend index ascending. */
export function slotShares(maglev: MaglevInspection): SlotShare[] {
  return Object.entries(maglev.slotCounts)
    .map(([backend, count]) => ({
      backend: Number(backend),
      count,
      fraction: maglev.tableSize > 0 ? count / maglev.tableSize : 0,
    }))
    .sort((a, b) => a.backend - b.backend);
}
