import type { WindowAggregate, WindowLatencySamples } from '@elbsim/protocol';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WindowAnalysis } from './WindowAnalysis';

/** A representative aggregate covering all stat tiles. */
const BASE_AGGREGATE: WindowAggregate = {
  fromMs: 0,
  toMs: 5000,
  totalRequests: 100,
  completed: 80,
  timedOut: 15,
  rejected: 5,
  goodput: 0.8,
  latencyP50: 12.3,
  latencyP90: 34.5,
  latencyP99: 56.7,
};

/** A small but non-trivial sample set. */
const BASE_SAMPLES: WindowLatencySamples = {
  fromMs: 0,
  toMs: 5000,
  latencies: [5, 10, 12, 15, 20, 25, 30, 35, 40, 50],
  capped: false,
};

describe('WindowAnalysis', () => {
  it('renders the header with the time range and request count', () => {
    render(<WindowAnalysis aggregate={BASE_AGGREGATE} samples={BASE_SAMPLES} />);
    expect(screen.getByText('Window analysis')).toBeInTheDocument();
    // Header shows totals from aggregate.
    expect(screen.getByText(/100 req/)).toBeInTheDocument();
  });

  it('renders percentile tiles from the aggregate', () => {
    render(<WindowAnalysis aggregate={BASE_AGGREGATE} samples={BASE_SAMPLES} />);
    expect(screen.getByText('12.3 ms')).toBeInTheDocument(); // p50
    expect(screen.getByText('34.5 ms')).toBeInTheDocument(); // p90
    expect(screen.getByText('56.7 ms')).toBeInTheDocument(); // p99
    // goodput appears in the tile; it also appears in the breakdown fraction,
    // so allow multiple matches.
    expect(screen.getAllByText('80.0%').length).toBeGreaterThanOrEqual(1);
  });

  it('renders the outcome breakdown from the aggregate', () => {
    render(<WindowAnalysis aggregate={BASE_AGGREGATE} samples={BASE_SAMPLES} />);
    expect(screen.getByText('Outcome breakdown')).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
    // Counts come from aggregate directly.
    const countEls = screen.getAllByText('80');
    expect(countEls.length).toBeGreaterThanOrEqual(1);
  });

  it('renders the CDF and histogram figures with SVGs', () => {
    const { container } = render(
      <WindowAnalysis aggregate={BASE_AGGREGATE} samples={BASE_SAMPLES} />,
    );
    expect(screen.getByText('Latency CDF')).toBeInTheDocument();
    expect(screen.getByText('Latency histogram')).toBeInTheDocument();
    // Observable Plot renders at least one SVG per figure.
    expect(container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2);
  });

  it('shows an empty state when totalRequests is zero', () => {
    const empty: WindowAggregate = {
      ...BASE_AGGREGATE,
      totalRequests: 0,
      completed: 0,
      timedOut: 0,
      rejected: 0,
      goodput: 0,
      latencyP50: 0,
      latencyP90: 0,
      latencyP99: 0,
    };
    const emptySamples: WindowLatencySamples = {
      ...BASE_SAMPLES,
      latencies: [],
    };
    render(<WindowAnalysis aggregate={empty} samples={emptySamples} />);
    expect(screen.getByText('No requests in the selected window.')).toBeInTheDocument();
    expect(screen.queryByText('Latency CDF')).not.toBeInTheDocument();
  });

  it('renders a dashed full-run CDF overlay when fullRunSamples is provided', () => {
    const fullRun: WindowLatencySamples = {
      fromMs: 0,
      toMs: 60_000,
      latencies: [3, 8, 12, 18, 22, 28, 32, 38, 45, 55, 70],
      capped: true,
    };
    const { container } = render(
      <WindowAnalysis aggregate={BASE_AGGREGATE} samples={BASE_SAMPLES} fullRunSamples={fullRun} />,
    );
    // Observable Plot sets stroke-dasharray on the <g> wrapper for a line mark.
    const dashedGroups = container.querySelectorAll('g[stroke-dasharray]');
    expect(dashedGroups.length).toBeGreaterThan(0);
  });
});
