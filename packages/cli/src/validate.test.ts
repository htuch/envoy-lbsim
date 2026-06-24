import { describe, expect, it } from 'vitest';
import { ALL_CASES, type LbValidationCase } from './cases/index';
import { ALL_POLICIES } from './cases/types';
import { runValidation } from './validate';

// Force mock everywhere so the suite runs without the Wasm artifact.
const mockMode = 'mock' as const;

/** A synthetic case whose check always fails (non-real-only). Used to exercise the fail path. */
const alwaysFailCase: LbValidationCase = {
  id: 'always-fail',
  title: 'A synthetic case whose check always fails',
  appliesTo: ['round_robin'],
  // Borrow build from the first case; the scenario content is irrelevant here.
  build: (policy) => (ALL_CASES[0] as LbValidationCase).build(policy),
  assert: () => [
    { label: 'never passes', pass: false, detail: 'synthetic fail', requiresReal: false },
  ],
};

describe('runValidation (structural, on the mock)', () => {
  it('produces a well-formed result for all policies', { timeout: 30_000 }, async () => {
    const result = await runValidation(ALL_POLICIES, mockMode);
    expect(result.policies).toHaveLength(ALL_POLICIES.length);
    for (const p of result.policies) {
      expect(p.lbLabel).toBe('mock');
      expect(p.cases.length).toBeGreaterThan(0);
      for (const c of p.cases) {
        for (const chk of c.checks) {
          expect(['pass', 'fail', 'skip']).toContain(chk.status);
        }
      }
    }
    expect(result.passed + result.failed + result.skipped).toBeGreaterThan(0);
  });

  it('marks real-only checks SKIP on the mock', async () => {
    const result = await runValidation(['maglev'], mockMode);
    const statuses = result.policies[0]?.cases.flatMap((c) => c.checks.map((k) => k.status)) ?? [];
    expect(statuses).toContain('skip');
  });

  it('only runs cases that apply to a policy', async () => {
    const result = await runValidation(['random'], mockMode);
    const ids = result.policies[0]?.cases.map((c) => c.id) ?? [];
    expect(ids).toContain('uniform-random');
    expect(ids).not.toContain('key-consistency');
  });

  it('counts failed checks and surfaces fail status for always-false checks', async () => {
    const result = await runValidation(['round_robin'], mockMode, undefined, [alwaysFailCase]);
    expect(result.failed).toBe(1);
    expect(result.passed).toBe(0);
    expect(result.skipped).toBe(0);
    const statuses = result.policies[0]?.cases.flatMap((c) => c.checks.map((k) => k.status)) ?? [];
    expect(statuses).toContain('fail');
  });
});
