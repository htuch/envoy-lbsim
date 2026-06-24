import type { WindowAggregate } from '@elbsim/protocol';

/**
 * Pure cold-path transforms for the analytical views, kept separate from the
 * Observable Plot rendering so the math is unit-testable without a DOM.
 */

export interface CdfPoint {
  latency: number;
  /** Cumulative fraction of completed requests at or below `latency`, in (0,1]. */
  p: number;
}

/**
 * Empirical CDF of completed-request latencies: one point per sample with its
 * cumulative fraction. Returns an empty series for an empty window.
 */
export function latencyCdf(latencies: number[]): CdfPoint[] {
  if (latencies.length === 0) return [];
  const sorted = [...latencies].sort((a, b) => a - b);
  const n = sorted.length;
  return sorted.map((latency, i) => ({ latency, p: (i + 1) / n }));
}

export interface OutcomeSlice {
  outcome: 'completed' | 'timed out' | 'rejected';
  count: number;
  /** Fraction of total offered requests, in [0,1]. */
  fraction: number;
  color: string;
}

const OUTCOME_COLORS = {
  completed: 'hsl(150 60% 42%)',
  'timed out': 'hsl(40 90% 50%)',
  rejected: 'hsl(0 72% 52%)',
} as const;

/** Break a window aggregate into completed / timed-out / rejected proportions. */
export function outcomeBreakdown(agg: WindowAggregate): OutcomeSlice[] {
  const total = agg.totalRequests;
  const slice = (outcome: OutcomeSlice['outcome'], count: number): OutcomeSlice => ({
    outcome,
    count,
    fraction: total > 0 ? count / total : 0,
    color: OUTCOME_COLORS[outcome],
  });
  return [
    slice('completed', agg.completed),
    slice('timed out', agg.timedOut),
    slice('rejected', agg.rejected),
  ];
}
