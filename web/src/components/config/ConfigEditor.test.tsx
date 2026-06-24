import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSimStore } from '@/store/sim-store';
import { MockSimRunner } from '@/worker/runner';
import { ConfigEditor } from './ConfigEditor';

function attach(): MockSimRunner {
  useSimStore.setState(useSimStore.getInitialState(), true);
  const runner = new MockSimRunner();
  useSimStore.getState().attach(runner);
  return runner;
}

describe('ConfigEditor', () => {
  beforeEach(attach);
  afterEach(() => useSimStore.setState(useSimStore.getInitialState(), true));

  it('edits config fields into the store draft', () => {
    render(<ConfigEditor />);
    fireEvent.change(screen.getByLabelText('Seed'), { target: { value: '42' } });
    expect(useSimStore.getState().config.seed).toBe(42);
    fireEvent.change(screen.getByLabelText('Duration (ms)'), { target: { value: '5000' } });
    expect(useSimStore.getState().config.time.durationMs).toBe(5000);
    fireEvent.change(screen.getByLabelText('Sample (ms)'), { target: { value: '5' } });
    expect(useSimStore.getState().config.time.sampleIntervalMs).toBe(5);
    fireEvent.change(screen.getAllByLabelText('Count')[0]!, { target: { value: '10' } }); // clients
    expect(useSimStore.getState().config.clients.count).toBe(10);
    fireEvent.change(screen.getByLabelText('Rate (/s)'), { target: { value: '30' } });
    expect(useSimStore.getState().config.clients.arrival.ratePerSec).toBe(30);
    fireEvent.change(screen.getByLabelText('Capacity'), { target: { value: '64' } });
    expect(useSimStore.getState().config.backends.defaults.capacity).toBe(64);
    fireEvent.change(screen.getByLabelText('Request (ms)'), { target: { value: '500' } });
    expect(useSimStore.getState().config.timeouts.requestTimeoutMs).toBe(500);
  });

  it('switches arrival process, preserving the configured rate', () => {
    render(<ConfigEditor />);
    fireEvent.change(screen.getByLabelText('Arrival process'), { target: { value: 'periodic' } });
    const arrival = useSimStore.getState().config.clients.arrival;
    expect(arrival.kind).toBe('periodic');
    expect(arrival.ratePerSec).toBe(20); // default rate carried over
  });

  it('switches policy and surfaces the right policy-specific control', () => {
    render(<ConfigEditor />);
    // Default scenario is maglev → table size visible.
    expect(screen.getByLabelText('Table size')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Table size'), { target: { value: '131' } });
    expect(useSimStore.getState().config.envoys.policy).toMatchObject({ tableSize: 131 });

    fireEvent.change(screen.getByLabelText('LB policy'), { target: { value: 'ring_hash' } });
    fireEvent.change(screen.getByLabelText('Min ring'), { target: { value: '2048' } });
    expect(useSimStore.getState().config.envoys.policy).toMatchObject({ minimumRingSize: 2048 });

    fireEvent.change(screen.getByLabelText('LB policy'), { target: { value: 'least_request' } });
    fireEvent.change(screen.getByLabelText('Choices'), { target: { value: '3' } });
    expect(useSimStore.getState().config.envoys.policy).toMatchObject({ choiceCount: 3 });

    fireEvent.change(screen.getByLabelText('LB policy'), { target: { value: 'random' } });
    expect(screen.queryByLabelText('Choices')).not.toBeInTheDocument();
    expect(useSimStore.getState().config.envoys.policy.kind).toBe('random');
  });

  it('edits the envoy count (second Count field)', () => {
    render(<ConfigEditor />);
    const counts = screen.getAllByLabelText('Count');
    fireEvent.change(counts[1]!, { target: { value: '6' } }); // envoys
    expect(useSimStore.getState().config.envoys.count).toBe(6);
    fireEvent.change(counts[2]!, { target: { value: '12' } }); // backends
    expect(useSimStore.getState().config.backends.count).toBe(12);
  });

  it('validates and applies a config, loading a fresh run', async () => {
    render(<ConfigEditor />);
    fireEvent.change(screen.getByLabelText('Duration (ms)'), { target: { value: '2000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply & reload' }));
    await waitFor(() => expect(useSimStore.getState().ready).toBe(true));
    expect(useSimStore.getState().status.state).toBe('paused');
  });

  it('shows a validation error for an out-of-range config', async () => {
    render(<ConfigEditor />);
    fireEvent.change(screen.getByLabelText('Duration (ms)'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply & reload' }));
    await screen.findByText(/Too small|greater than|positive|>/i);
    expect(useSimStore.getState().ready).toBe(false);
  });
});
