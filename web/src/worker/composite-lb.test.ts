import type { CommonLbConfig, EnvoyLbPolicy } from '@elbsim/config';
import type { LbInstance, LbModule } from '@elbsim/protocol';
import { expect, test } from 'vitest';
import { makeCompositeLbModule } from './composite-lb';

test('composite routes maglev to real and others to mock', () => {
  const calls: string[] = [];
  const stub = (tag: string): LbModule => ({
    createLb: (p: EnvoyLbPolicy): LbInstance => {
      calls.push(`${tag}:${p.kind}`);
      return {} as LbInstance;
    },
  });
  const real = stub('real');
  const mock = stub('mock');
  const c = makeCompositeLbModule(real, mock);
  c.createLb({ kind: 'maglev', tableSize: 7 } as EnvoyLbPolicy, {} as CommonLbConfig, 1);
  c.createLb({ kind: 'round_robin' } as EnvoyLbPolicy, {} as CommonLbConfig, 1);
  expect(calls).toEqual(['real:maglev', 'mock:round_robin']);
});
