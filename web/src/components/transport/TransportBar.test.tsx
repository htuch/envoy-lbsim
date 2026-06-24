import { defaultSimConfig } from '@elbsim/config';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('speed selector renders all speeds and selecting 2x calls setSpeed(2)', async () => {
    const spy = vi.spyOn(useSimStore.getState(), 'setSpeed');
    render(<TransportBar />);
    const speedSelect = screen.getByLabelText('Playback speed');
    // All six speed options are present.
    expect(speedSelect).toBeInTheDocument();
    const options = Array.from((speedSelect as HTMLSelectElement).options).map((o) => o.value);
    expect(options).toEqual(['0.25', '0.5', '1', '2', '4', '8']);
    // Selecting 2x dispatches setSpeed(2).
    fireEvent.change(speedSelect, { target: { value: '2' } });
    await waitFor(() => expect(spy).toHaveBeenCalledWith(2));
  });

  it('overlays a window band on the seek track when selection is set', () => {
    useSimStore.getState().setSelection({ fromMs: 20_000, toMs: 60_000 });
    render(<TransportBar />);
    // The band element must be present.
    const band = document.querySelector('[data-window-band]');
    expect(band).toBeInTheDocument();
    // Band spans 20000..60000 over 100000ms total => left 20%, width 40%.
    // We verify the inline style contains these values.
    const style = (band as HTMLElement).getAttribute('style') ?? '';
    expect(style).toContain('20%');
    expect(style).toContain('40%');
  });

  it('shows no window band when selection is null', () => {
    render(<TransportBar />);
    expect(document.querySelector('[data-window-band]')).not.toBeInTheDocument();
  });
});

describe('boot config maglev default', () => {
  it('defaultSimConfig boots with policy.kind === maglev', () => {
    const cfg = defaultSimConfig();
    expect(cfg.envoys.policy.kind).toBe('maglev');
  });
});
