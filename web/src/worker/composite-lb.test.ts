import { expect, test } from 'vitest';
import { makeCompositeLbModule } from './composite-lb';

test('composite routes maglev to real and others to mock', () => {
  const calls: string[] = [];
  const real = { createLb: (p: { kind: string }) => (calls.push(`real:${p.kind}`), {} as any) };
  const mock = { createLb: (p: { kind: string }) => (calls.push(`mock:${p.kind}`), {} as any) };
  const c = makeCompositeLbModule(real as any, mock as any);
  c.createLb({ kind: 'maglev', tableSize: 7 } as any, {} as any, 1);
  c.createLb({ kind: 'round_robin' } as any, {} as any, 1);
  expect(calls).toEqual(['real:maglev', 'mock:round_robin']);
});
