import { shares } from './distribution';
import { scenario } from './scenario';
import type { Check, LbValidationCase } from './types';

export const leastRequestCases: LbValidationCase[] = [
  {
    id: 'favors-idle',
    title: 'Least-request sends less traffic to a slow (high active-count) host',
    appliesTo: ['least_request'],
    build: (p) =>
      // Backend 0 is much slower (lower capacity + higher service latency), so it
      // accrues active requests and least_request should steer away from it.
      scenario(p, {
        backends: 4,
        ratePerSec: 80,
        overrides: { '0': { capacity: 4, latency: { kind: 'lognormal', mu: 3.2, sigma: 0.4 } } },
      }),
    assert: (s): Check[] => {
      const sh = shares(s.perBackend);
      /* c8 ignore next -- ?? 0 only triggers if backend 0 absent, never with 4 active backends */
      const slow = sh.get(0) ?? 0;
      const others = [1, 2, 3].map((b) => sh.get(b) ?? 0);
      const avgOther = others.reduce((a, b) => a + b, 0) / others.length;
      return [
        {
          label: 'slow host share below the average of the others',
          pass: slow < avgOther,
          detail: `slow=${(slow * 100).toFixed(2)}% avgOther=${(avgOther * 100).toFixed(2)}%`,
          requiresReal: true,
        },
      ];
    },
  },
];
