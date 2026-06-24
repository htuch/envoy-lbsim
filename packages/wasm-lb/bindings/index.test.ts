import { expect, test } from 'vitest';
import { normalizeStructure } from './index';

test('maglev inspect raw val becomes a MaglevInspection', () => {
  const raw = { kind: 'maglev', tableSize: 5, table: [0, 1, 0, 2, 1] };
  const s = normalizeStructure(raw);
  expect(s.kind).toBe('maglev');
  if (s.kind !== 'maglev') throw new Error('kind');
  expect(s.table).toBeInstanceOf(Uint32Array);
  expect(Array.from(s.table)).toEqual([0, 1, 0, 2, 1]);
  expect(s.tableSize).toBe(5);
  expect(s.slotCounts).toEqual({ 0: 2, 1: 2, 2: 1 });
});

test('non-maglev structures pass through unchanged', () => {
  expect(normalizeStructure({ kind: 'none' })).toEqual({ kind: 'none' });
});
