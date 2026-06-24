import { mockLbModule } from '@elbsim/sim-core';
import { describe, expect, it } from 'vitest';
import { runScenario } from '../driver';
import { computeStats } from '../stats';
import { crossCuttingCases } from './cross-cutting';
import type { CaseContext } from './types';

function runCase(caseId: string, policy: 'round_robin' = 'round_robin') {
  const c = crossCuttingCases.find((x) => x.id === caseId);
  if (!c) throw new Error(`no case ${caseId}`);
  const config = c.build(policy);
  const { events } = runScenario(config, { module: mockLbModule, label: 'mock' });
  const stats = computeStats(events);
  const ctx: CaseContext = { policy, config, lbLabel: 'mock', lbModule: mockLbModule, events };
  return c.assert(stats, ctx);
}

describe('cross-cutting cases on the mock', () => {
  it('goodput-range passes', () => {
    expect(runCase('goodput-range').every((c) => c.pass)).toBe(true);
  });
  it('lifecycle-conservation passes', () => {
    expect(runCase('lifecycle-conservation').every((c) => c.pass)).toBe(true);
  });
  it('determinism passes', () => {
    expect(runCase('determinism').every((c) => c.pass)).toBe(true);
  });
  it('stats-aggregation passes (queryWindow matches recompute)', () => {
    expect(runCase('stats-aggregation').every((c) => c.pass)).toBe(true);
  });
  it('no-unhealthy-traffic passes (unhealthy host gets no picks)', () => {
    expect(runCase('no-unhealthy-traffic').every((c) => c.pass)).toBe(true);
  });
});
