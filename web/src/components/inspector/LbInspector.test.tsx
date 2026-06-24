import type { LbInspection } from '@elbsim/protocol';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { harnessScenario } from '@/components/harness/scenario';
import { makeInspection } from '@/synthetic';
import { LbInspector } from './LbInspector';

const config = harnessScenario();

describe('LbInspector', () => {
  it('always renders the resolved host set', () => {
    const inspection = makeInspection(config, 0, 0, 'maglev');
    render(<LbInspector inspection={inspection} />);
    expect(screen.getByText('Resolved hosts')).toBeInTheDocument();
    // One row per backend (b0 also appears in the Maglev shares, hence getAll).
    expect(screen.getAllByText('b0').length).toBeGreaterThan(0);
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  it('renders the Maglev table with a slot strip and shares', () => {
    render(<LbInspector inspection={makeInspection(config, 0, 0, 'maglev')} />);
    expect(screen.getByText('Maglev table')).toBeInTheDocument();
    expect(screen.getByText('table_size')).toBeInTheDocument();
    expect(screen.getByLabelText('Maglev slot strip')).toBeInTheDocument();
  });

  it('renders the EDF scheduler heap with the next pick highlighted', () => {
    render(<LbInspector inspection={makeInspection(config, 0, 0, 'round_robin')} />);
    expect(screen.getByText('EDF scheduler')).toBeInTheDocument();
    expect(screen.getByText(/current_time/)).toBeInTheDocument();
    expect(screen.getByText('next')).toBeInTheDocument();
  });

  it('renders the hash ring', () => {
    render(<LbInspector inspection={makeInspection(config, 0, 0, 'ring_hash')} />);
    expect(screen.getByText('Hash ring')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Hash ring/ })).toBeInTheDocument();
  });

  it('explains the stateless random policy', () => {
    render(<LbInspector inspection={makeInspection(config, 0, 0, 'random')} />);
    expect(screen.getByText('No structure')).toBeInTheDocument();
    expect(screen.getByText(/no persistent structure/)).toBeInTheDocument();
  });

  it('shows the panic badge when the priority set is in panic', () => {
    const panicked: LbInspection = {
      envoy: 2,
      t: 1200,
      policy: 'random',
      panic: true,
      hosts: [],
      structure: { kind: 'none' },
    };
    render(<LbInspector inspection={panicked} />);
    expect(screen.getByText('PANIC')).toBeInTheDocument();
    expect(screen.getByText('e2')).toBeInTheDocument();
  });
});
