import { scenario } from './scenario';
import type { Check, LbValidationCase } from './types';

/** Backend -> fraction of total picks. */
export function shares(perBackend: Map<number, { picks: number }>): Map<number, number> {
  let total = 0;
  for (const c of perBackend.values()) total += c.picks;
  const out = new Map<number, number>();
  if (total === 0) return out;
  for (const [b, c] of perBackend) out.set(b, c.picks / total);
  return out;
}

export const distributionCases: LbValidationCase[] = [
  {
    id: 'even-distribution',
    title: 'Round robin spreads picks evenly across equal-weight healthy hosts',
    appliesTo: ['round_robin'],
    build: (p) => scenario(p, { backends: 6 }),
    assert: (s): Check[] => {
      const sh = shares(s.perBackend);
      const expected = 1 / sh.size;
      let worst = 0;
      for (const frac of sh.values()) worst = Math.max(worst, Math.abs(frac - expected));
      return [
        {
          label: 'each host within 5% of even share',
          pass: sh.size > 0 && worst < 0.05,
          detail: `hosts=${sh.size} worst dev=${(worst * 100).toFixed(2)}%`,
          requiresReal: false,
        },
      ];
    },
  },
  {
    id: 'weighted-distribution',
    title: 'Pick share tracks host weight',
    appliesTo: ['round_robin', 'least_request', 'ring_hash', 'maglev'],
    build: (p) =>
      scenario(p, {
        backends: 4,
        durationMs: 8_000,
        keys: { kind: 'uniform', n: 100_000 },
        overrides: { '0': { weight: 4 }, '1': { weight: 2 } },
      }),
    assert: (s): Check[] => {
      // weights: b0=4, b1=2, b2=1, b3=1 -> total 8
      const weights = new Map<number, number>([
        [0, 4 / 8],
        [1, 2 / 8],
        [2, 1 / 8],
        [3, 1 / 8],
      ]);
      const sh = shares(s.perBackend);
      let worst = 0;
      for (const [b, w] of weights) worst = Math.max(worst, Math.abs((sh.get(b) ?? 0) - w));
      return [
        {
          label: 'weighted share within 5%',
          pass: worst < 0.05,
          detail: `worst dev=${(worst * 100).toFixed(2)}%`,
          requiresReal: true,
        },
      ];
    },
  },
  {
    id: 'uniform-random',
    title: 'Random spreads picks approximately uniformly',
    appliesTo: ['random'],
    build: (p) => scenario(p, { backends: 5, durationMs: 8_000 }),
    assert: (s): Check[] => {
      const sh = shares(s.perBackend);
      const expected = 1 / sh.size;
      let worst = 0;
      for (const frac of sh.values()) worst = Math.max(worst, Math.abs(frac - expected));
      return [
        {
          label: 'each host within 8% of uniform share',
          pass: sh.size > 0 && worst < 0.08,
          detail: `hosts=${sh.size} worst dev=${(worst * 100).toFixed(2)}%`,
          requiresReal: false,
        },
      ];
    },
  },
];
