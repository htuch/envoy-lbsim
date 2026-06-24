import { SimController } from '@elbsim/sim-core';
import { runScenario } from '../driver';
import { computeStats } from '../stats';
import { scenario } from './scenario';
import { ALL_POLICIES, type Check, type LbValidationCase } from './types';

/** Build a distribution signature (backend -> picks) for equality comparison. */
function pickSignature(perBackend: Map<number, { picks: number }>): string {
  return [...perBackend.entries()]
    .sort(([a], [b]) => a - b)
    .map(([b, c]) => `${b}:${c.picks}`)
    .join(',');
}

export const crossCuttingCases: LbValidationCase[] = [
  {
    id: 'goodput-range',
    title: 'Goodput is a fraction in [0,1] over a non-empty run',
    appliesTo: ALL_POLICIES,
    build: (p) => scenario(p),
    assert: (s): Check[] => [
      {
        label: 'goodput in [0,1]',
        pass: s.goodput >= 0 && s.goodput <= 1 && s.outcomes.total > 0,
        detail: `goodput=${s.goodput.toFixed(4)} total=${s.outcomes.total}`,
        requiresReal: false,
      },
    ],
  },
  {
    id: 'lifecycle-conservation',
    title: 'Every emitted request reaches exactly one terminal outcome',
    appliesTo: ALL_POLICIES,
    build: (p) => scenario(p),
    assert: (s): Check[] => {
      const { completed, timedOut, rejected, total } = s.outcomes;
      const terminal = completed + timedOut + rejected;
      return [
        {
          label: 'emitted == completed + timed_out + rejected',
          pass: terminal === total,
          detail: `emitted=${total} terminal=${terminal} (c=${completed} t=${timedOut} r=${rejected})`,
          requiresReal: false,
        },
      ];
    },
  },
  {
    id: 'determinism',
    title: 'Identical config and seed yield an identical pick distribution',
    appliesTo: ALL_POLICIES,
    build: (p) => scenario(p),
    assert: (s, ctx): Check[] => {
      const again = runScenario(ctx.config, { module: ctx.lbModule, label: ctx.lbLabel });
      const sig = pickSignature(s.perBackend);
      const sigAgain = pickSignature(computeStats(again.events).perBackend);
      const match = sig === sigAgain;
      return [
        {
          label: 'rerun pick distribution matches',
          pass: match,
          /* c8 ignore next */
          detail: match ? `${s.perBackend.size} backends stable` : `${sig} != ${sigAgain}`,
          requiresReal: false,
        },
      ];
    },
  },
  {
    id: 'stats-aggregation',
    title: 'SimController.queryWindow agrees with the independent recompute',
    appliesTo: ALL_POLICIES,
    build: (p) => scenario(p),
    assert: (s, ctx): Check[] => {
      const checks: Check[] = [];
      const controller = new SimController({ lbModule: ctx.lbModule });
      // queryWindow does its own fully-drained replay; loadConfigSync is enough.
      controller.loadConfigSync(ctx.config);
      const agg = controller.queryWindowSync({ fromMs: 0, toMs: ctx.config.time.durationMs });
      const near = (a: number, b: number) =>
        Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
      checks.push({
        label: 'goodput matches queryWindow',
        pass: near(agg.goodput, s.goodput),
        detail: `window=${agg.goodput.toFixed(6)} recompute=${s.goodput.toFixed(6)}`,
        requiresReal: false,
      });
      checks.push({
        label: 'p99 latency matches queryWindow',
        pass: near(agg.latencyP99, s.latencyP99),
        detail: `window=${agg.latencyP99.toFixed(4)} recompute=${s.latencyP99.toFixed(4)}`,
        requiresReal: false,
      });
      return checks;
    },
  },
  {
    id: 'no-unhealthy-traffic',
    title: 'An unhealthy backend receives no LB picks',
    appliesTo: ALL_POLICIES,
    build: (p) => scenario(p, { backends: 5, overrides: { '0': { health: 'unhealthy' } } }),
    assert: (s): Check[] => {
      const picks = s.perBackend.get(0)?.picks ?? 0;
      return [
        {
          label: 'backend 0 (unhealthy) has zero picks',
          pass: picks === 0,
          detail: `backend0 picks=${picks}`,
          requiresReal: false,
        },
      ];
    },
  },
];
