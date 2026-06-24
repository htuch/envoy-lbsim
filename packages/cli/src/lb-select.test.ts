import type { EnvoyLbPolicyKind } from '@elbsim/config';
import type { LbModule } from '@elbsim/protocol';
import { mockLbModule } from '@elbsim/sim-core';
import { describe, expect, it } from 'vitest';
import { LIFTED_POLICIES, selectLb } from './lb-select';

const fakeReal = mockLbModule as unknown as LbModule; // a stand-in "real" module
const present = { loadReal: async () => fakeReal };
const absent = { loadReal: async () => undefined };

describe('selectLb', () => {
  it('mode mock always returns the mock', async () => {
    const s = await selectLb('maglev', 'mock', present);
    expect(s.label).toBe('mock');
    expect(s.module).toBe(mockLbModule);
  });

  it('mode real throws for a policy not in LIFTED_POLICIES', async () => {
    // All real policy kinds are lifted today, so exercise the gate with a kind
    // outside the set (e.g. a future policy not yet backed by Wasm).
    const future = 'future_policy' as EnvoyLbPolicyKind;
    await expect(selectLb(future, 'real', present)).rejects.toThrow(/not lifted/);
  });

  it('mode real throws when the artifact is absent', async () => {
    await expect(selectLb('maglev', 'real', absent)).rejects.toThrow(/not built/);
  });

  it('mode real returns the real module when present', async () => {
    const s = await selectLb('ring_hash', 'real', present);
    expect(s.label).toBe('real');
  });

  it('exposes all five Envoy policies as lifted', () => {
    for (const p of ['maglev', 'ring_hash', 'round_robin', 'least_request', 'random'] as const) {
      expect(LIFTED_POLICIES.has(p)).toBe(true);
    }
  });
});
