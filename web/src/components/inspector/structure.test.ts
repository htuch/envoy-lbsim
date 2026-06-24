import type { MaglevInspection, RingHashInspection } from '@elbsim/protocol';
import { describe, expect, it } from 'vitest';
import { backendColor } from './colors';
import { downsampleTable, hashFraction, ringPoints, slotShares } from './structure';

describe('backendColor', () => {
  it('is stable per index and cycles through the palette', () => {
    expect(backendColor(0)).toBe(backendColor(0));
    expect(backendColor(0)).toBe(backendColor(10));
    expect(backendColor(0)).not.toBe(backendColor(1));
  });
});

describe('downsampleTable', () => {
  it('returns the table verbatim when it fits the bucket budget', () => {
    expect(downsampleTable(Uint32Array.from([0, 1, 2]), 8)).toEqual([0, 1, 2]);
  });

  it('samples evenly down to the bucket count for a large table', () => {
    const table = Uint32Array.from({ length: 1000 }, (_, i) => i % 3);
    const out = downsampleTable(table, 50);
    expect(out).toHaveLength(50);
    expect(out.every((v) => v >= 0 && v <= 2)).toBe(true);
  });
});

describe('hashFraction', () => {
  it('maps hex hashes to [0,1) and preserves order', () => {
    expect(hashFraction('0000000000000000')).toBe(0);
    expect(hashFraction('8000000000000000')).toBeCloseTo(0.5);
    expect(hashFraction('ffffffff00000000')).toBeCloseTo(1, 5);
    expect(hashFraction('1000000000000000')).toBeLessThan(hashFraction('2000000000000000'));
  });
});

describe('ringPoints', () => {
  const ring: RingHashInspection = {
    kind: 'ring',
    size: 4,
    entries: [
      { hash: '1000000000000000', backend: 0 },
      { hash: '4000000000000000', backend: 1 },
      { hash: '8000000000000000', backend: 0 },
      { hash: 'c000000000000000', backend: 1 },
    ],
  };

  it('maps every point when within the budget', () => {
    const pts = ringPoints(ring, 360);
    expect(pts).toHaveLength(4);
    expect(pts[0]).toMatchObject({ backend: 0 });
    expect(pts[1]!.fraction).toBeCloseTo(0.25);
  });

  it('downsamples a dense ring to the tick budget', () => {
    const dense: RingHashInspection = {
      kind: 'ring',
      size: 100,
      entries: Array.from({ length: 100 }, (_, i) => ({
        hash: ((i / 100) * 0xffffffff).toString(16).padStart(8, '0').padEnd(16, '0'),
        backend: i % 4,
      })),
    };
    expect(ringPoints(dense, 20)).toHaveLength(20);
  });
});

describe('slotShares', () => {
  it('reports per-backend share sorted by backend index', () => {
    const maglev: MaglevInspection = {
      kind: 'maglev',
      tableSize: 100,
      table: new Uint32Array(),
      slotCounts: { 2: 25, 0: 50, 1: 25 },
    };
    const shares = slotShares(maglev);
    expect(shares.map((s) => s.backend)).toEqual([0, 1, 2]);
    expect(shares[0]).toMatchObject({ count: 50, fraction: 0.5 });
  });

  it('reports zero fractions for an empty (zero-size) table', () => {
    const maglev: MaglevInspection = {
      kind: 'maglev',
      tableSize: 0,
      table: new Uint32Array(),
      slotCounts: { 0: 0 },
    };
    expect(slotShares(maglev)[0]).toMatchObject({ fraction: 0 });
  });
});
