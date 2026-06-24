import { mockLbModule } from '@elbsim/sim-core';
import { describe, expect, it } from 'vitest';
import { runScenario } from '../driver';
import { computeStats } from '../stats';
import { ALL_CASES } from './index';
import type { CaseContext, LbValidationCase } from './types';

function check(c: LbValidationCase, policy: 'round_robin' | 'random' | 'maglev' | 'least_request') {
  const config = c.build(policy);
  const { events } = runScenario(config, { module: mockLbModule, label: 'mock' });
  const stats = computeStats(events);
  const ctx: CaseContext = { policy, config, lbLabel: 'mock', lbModule: mockLbModule, events };
  return c.assert(stats, ctx);
}

function find(id: string): LbValidationCase {
  const c = ALL_CASES.find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
}

describe('per-policy cases', () => {
  it('registry includes cross-cutting and per-policy cases', () => {
    const ids = ALL_CASES.map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'goodput-range',
        'even-distribution',
        'weighted-distribution',
        'uniform-random',
        'key-consistency',
        'favors-idle',
      ]),
    );
  });

  it('even-distribution passes on mock round_robin', () => {
    expect(check(find('even-distribution'), 'round_robin').every((c) => c.pass)).toBe(true);
  });

  it('uniform-random produces all checks (statistical, may vary)', () => {
    expect(check(find('uniform-random'), 'random').length).toBeGreaterThan(0);
  });

  it('key-consistency passes on mock maglev (modulo is key-stable)', () => {
    expect(check(find('key-consistency'), 'maglev').every((c) => c.pass)).toBe(true);
  });

  it('weighted-distribution is marked requiresReal', () => {
    expect(check(find('weighted-distribution'), 'maglev').every((c) => c.requiresReal)).toBe(true);
  });

  it('favors-idle is marked requiresReal', () => {
    expect(check(find('favors-idle'), 'least_request').every((c) => c.requiresReal)).toBe(true);
  });
});
