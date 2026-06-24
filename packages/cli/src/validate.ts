import type { EnvoyLbPolicyKind } from '@elbsim/config';
import { ALL_CASES, type LbValidationCase } from './cases/index';
import type { CaseContext, Check } from './cases/types';
import type { LbLabel } from './driver';
import { runScenario } from './driver';
import { type LbMode, type SelectDeps, selectLb } from './lb-select';
import { computeStats } from './stats';

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface CheckResult extends Check {
  status: CheckStatus;
}

export interface CaseResult {
  id: string;
  title: string;
  checks: CheckResult[];
}

export interface PolicyResult {
  policy: EnvoyLbPolicyKind;
  lbLabel: LbLabel;
  cases: CaseResult[];
}

export interface ValidationResult {
  policies: PolicyResult[];
  passed: number;
  failed: number;
  skipped: number;
}

/**
 * Run the case library across the given policies. Real-only checks running on
 * the mock are reported SKIP (they upgrade to live as Track A lifts policies).
 * Behavioral pass/fail is informational here; the CLI is the exploration tool,
 * not a CI gate.
 */
export async function runValidation(
  policies: readonly EnvoyLbPolicyKind[],
  mode: LbMode,
  deps?: SelectDeps,
  cases: readonly LbValidationCase[] = ALL_CASES,
): Promise<ValidationResult> {
  const out: PolicyResult[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const policy of policies) {
    const sel = await selectLb(policy, mode, deps);
    const caseResults: CaseResult[] = [];

    for (const c of cases) {
      if (!c.appliesTo.includes(policy)) continue;
      const config = c.build(policy);
      const { events } = runScenario(config, { module: sel.module, label: sel.label });
      const stats = computeStats(events);
      const ctx: CaseContext = {
        policy,
        config,
        lbLabel: sel.label,
        lbModule: sel.module,
        events,
      };
      const checks = c.assert(stats, ctx).map((chk): CheckResult => {
        if (chk.requiresReal && sel.label === 'mock') {
          skipped++;
          return { ...chk, status: 'skip' };
        }
        if (chk.pass) passed++;
        else failed++;
        return { ...chk, status: chk.pass ? 'pass' : 'fail' };
      });
      caseResults.push({ id: c.id, title: c.title, checks });
    }

    out.push({
      policy,
      lbLabel: sel.label,
      cases: caseResults,
    });
  }

  return { policies: out, passed, failed, skipped };
}
