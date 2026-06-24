import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { harnessScenario } from '@/components/harness/scenario';
import { type LatencyWindow, makeLatencyWindow } from '@/synthetic';
import { WindowAnalysis } from './WindowAnalysis';

describe('WindowAnalysis', () => {
  it('renders summary stats, the breakdown, and the distribution figures', () => {
    const window = makeLatencyWindow(harnessScenario(), 0, 5000);
    const { container } = render(<WindowAnalysis window={window} />);

    expect(screen.getByText('Window analysis')).toBeInTheDocument();
    expect(screen.getByText('goodput')).toBeInTheDocument();
    expect(screen.getByText('Outcome breakdown')).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
    expect(screen.getByText('Latency CDF')).toBeInTheDocument();
    expect(screen.getByText('Latency histogram')).toBeInTheDocument();
    // Observable Plot renders an SVG per figure.
    expect(container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2);
  });

  it('shows an empty state when the window has no requests', () => {
    const empty: LatencyWindow = {
      fromMs: 100,
      toMs: 100,
      latencies: [],
      timedOut: 0,
      rejected: 0,
    };
    render(<WindowAnalysis window={empty} />);
    expect(screen.getByText('No requests in the selected window.')).toBeInTheDocument();
    expect(screen.queryByText('Latency CDF')).not.toBeInTheDocument();
  });
});
