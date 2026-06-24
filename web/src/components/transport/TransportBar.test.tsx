import { defaultSimConfig } from '@elbsim/config';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSimStore } from '@/store/sim-store';
import { MockSimRunner } from '@/worker/runner';
import { TransportBar } from './TransportBar';

let runner: MockSimRunner;

async function loadStore(): Promise<void> {
  useSimStore.setState(useSimStore.getInitialState(), true);
  runner = new MockSimRunner();
  useSimStore.getState().attach(runner);
  // A long run so playback does not finish mid-test.
  await useSimStore.getState().load({
    ...defaultSimConfig(),
    time: { durationMs: 100_000, sampleIntervalMs: 10 },
  });
}

describe('TransportBar', () => {
  beforeEach(loadStore);
  afterEach(() => {
    runner.dispose();
    useSimStore.setState(useSimStore.getInitialState(), true);
  });

  it('renders the clock readout and a seek track', () => {
    render(<TransportBar />);
    expect(screen.getByText('0.00s / 100.00s')).toBeInTheDocument();
    expect(screen.getByLabelText('Seek')).toBeInTheDocument();
  });

  it('toggles play/pause and mirrors worker status while running', async () => {
    render(<TransportBar />);
    fireEvent.click(screen.getByLabelText('Play'));
    await screen.findByLabelText('Pause');
    // The low-rate sync effect pulls advancing virtual time from the worker.
    await waitFor(() => expect(useSimStore.getState().status.virtualTimeMs).toBeGreaterThan(0));
    fireEvent.click(screen.getByLabelText('Pause'));
    await screen.findByLabelText('Play');
    expect(useSimStore.getState().status.state).toBe('paused');
  });

  it('steps, resets, changes speed, and scrubs via the seek track', async () => {
    render(<TransportBar />);
    fireEvent.click(screen.getByLabelText('Step one sample interval'));
    await waitFor(() => expect(useSimStore.getState().status.virtualTimeMs).toBe(10));

    fireEvent.change(screen.getByLabelText('Playback speed'), { target: { value: '4' } });

    fireEvent.change(screen.getByLabelText('Seek'), { target: { value: '5000' } });
    await waitFor(() => expect(useSimStore.getState().status.virtualTimeMs).toBe(5000));

    fireEvent.click(screen.getByLabelText('Reset to start'));
    await waitFor(() => expect(useSimStore.getState().status.virtualTimeMs).toBe(0));
  });

  it('surfaces a reset-zoom control for a brushed window and clears it', () => {
    useSimStore.getState().setSelection({ fromMs: 1200, toMs: 3400 });
    render(<TransportBar />);
    const reset = screen.getByLabelText('Reset zoom');
    expect(reset).toHaveTextContent('1.20–3.40s');
    fireEvent.click(reset);
    expect(useSimStore.getState().selection).toBeNull();
  });

  it('hides the reset-zoom control when no window is selected', () => {
    render(<TransportBar />);
    expect(screen.queryByLabelText('Reset zoom')).not.toBeInTheDocument();
  });
});
