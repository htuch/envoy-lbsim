import { scenario } from './scenario';
import type { Check, LbValidationCase } from './types';

export const consistencyCases: LbValidationCase[] = [
  {
    id: 'key-consistency',
    title: 'Each request key maps to a single backend for the whole run',
    appliesTo: ['ring_hash', 'maglev'],
    build: (p) => scenario(p, { backends: 6 }),
    assert: (s): Check[] => {
      let multi = 0;
      let worstKey = -1;
      for (const [key, set] of s.keyConsistency) {
        /* c8 ignore next 4 -- only reachable when a buggy LB routes a key to multiple backends */
        if (set.size > 1) {
          multi++;
          if (worstKey < 0) worstKey = key;
        }
      }
      return [
        {
          label: 'no key routed to more than one backend',
          pass: s.keyConsistency.size > 0 && multi === 0,
          /* c8 ignore next 4 -- false branch only reachable when LB is inconsistent */
          detail:
            multi === 0
              ? `${s.keyConsistency.size} distinct keys, all stable`
              : `${multi} keys split (e.g. key ${worstKey})`,
          requiresReal: false,
        },
      ];
    },
  },
];
