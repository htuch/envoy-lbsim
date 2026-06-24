import { mockLbModule } from '@elbsim/sim-core';
import { describe, expect, it } from 'vitest';
import type { Stats } from '../stats';
import { consistencyCases } from './consistency';
import { scenario } from './scenario';
import type { CaseContext } from './types';

function makeStats(keyConsistency: Map<number, Set<number>>): Stats {
  return {
    perBackend: new Map(),
    perEnvoy: new Map(),
    outcomes: { completed: 0, timedOut: 0, rejected: 0, total: 0 },
    goodput: 0,
    latencyP50: 0,
    latencyP90: 0,
    latencyP99: 0,
    keyConsistency,
  };
}

function makeCtx(): CaseContext {
  return {
    policy: 'maglev',
    config: scenario('maglev'),
    lbLabel: 'mock',
    lbModule: mockLbModule,
    events: [],
  };
}

describe('key-consistency assert', () => {
  const theCase = consistencyCases.find((c) => c.id === 'key-consistency');

  it('finds the key-consistency case', () => {
    expect(theCase).toBeDefined();
  });

  it('fails when a key maps to more than one backend (exercises set.size > 1 branch)', () => {
    if (!theCase) throw new Error('key-consistency case not found');

    // Keys 7 and 9 both route to two backends; key 3 is stable.
    // Having two split keys exercises both the worstKey < 0 (true) and
    // worstKey >= 0 (false) branches of the inner guard on line 16.
    const stats = makeStats(
      new Map([
        [7, new Set([1, 2])],
        [9, new Set([0, 3])],
        [3, new Set([0])],
      ]),
    );

    const checks = theCase.assert(stats, makeCtx());
    expect(checks.length).toBe(1);
    expect(checks[0]?.pass).toBe(false);
    // The false detail branch should mention the split and the offending key.
    expect(checks[0]?.detail).toMatch(/split/);
    expect(checks[0]?.detail).toContain('7');
  });

  it('passes when every key maps to exactly one backend', () => {
    if (!theCase) throw new Error('key-consistency case not found');

    const stats = makeStats(
      new Map([
        [1, new Set([0])],
        [2, new Set([3])],
        [5, new Set([2])],
      ]),
    );

    const checks = theCase.assert(stats, makeCtx());
    expect(checks.length).toBe(1);
    expect(checks[0]?.pass).toBe(true);
    expect(checks[0]?.detail).toMatch(/distinct keys/);
  });
});
