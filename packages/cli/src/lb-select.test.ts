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

  it('mode real throws for an unlifted policy', async () => {
    await expect(selectLb('random', 'real', present)).rejects.toThrow(/not lifted/);
  });

  it('mode real throws when the artifact is absent', async () => {
    await expect(selectLb('maglev', 'real', absent)).rejects.toThrow(/not built/);
  });

  it('mode real returns the real module when present', async () => {
    const s = await selectLb('maglev', 'real', present);
    expect(s.label).toBe('real');
  });

  it('exposes maglev as a lifted policy', () => {
    expect(LIFTED_POLICIES.has('maglev')).toBe(true);
    expect(LIFTED_POLICIES.has('ring_hash')).toBe(false);
  });
});
