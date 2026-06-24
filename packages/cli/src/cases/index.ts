import { consistencyCases } from './consistency';
import { crossCuttingCases } from './cross-cutting';
import { distributionCases } from './distribution';
import { leastRequestCases } from './least-request';
import type { LbValidationCase } from './types';

/** The full validation case library, run by `elbsim validate`. */
export const ALL_CASES: readonly LbValidationCase[] = [
  ...crossCuttingCases,
  ...distributionCases,
  ...consistencyCases,
  ...leastRequestCases,
];

export * from './types';
