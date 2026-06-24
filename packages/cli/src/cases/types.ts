import type { EnvoyLbPolicyKind, SimConfig } from '@elbsim/config';
import type { LbModule, RequestEvent } from '@elbsim/protocol';
import type { LbLabel } from '../driver';
import type { Stats } from '../stats';

/** A single asserted property of a run. `requiresReal` checks SKIP on the mock. */
export interface Check {
  label: string;
  pass: boolean;
  detail: string;
  requiresReal: boolean;
}

/** Inputs a case's assert() may use beyond the headline Stats. */
export interface CaseContext {
  policy: EnvoyLbPolicyKind;
  config: SimConfig;
  lbLabel: LbLabel;
  lbModule: LbModule;
  events: readonly RequestEvent[];
}

/** One validation case: a scenario plus the expectations it asserts. */
export interface LbValidationCase {
  id: string;
  title: string;
  appliesTo: readonly EnvoyLbPolicyKind[];
  build: (policy: EnvoyLbPolicyKind) => SimConfig;
  assert: (stats: Stats, ctx: CaseContext) => Check[];
}

export const ALL_POLICIES: readonly EnvoyLbPolicyKind[] = [
  'round_robin',
  'least_request',
  'random',
  'ring_hash',
  'maglev',
];
