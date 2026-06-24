import { safeParseSimConfig } from '@elbsim/config';
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

  it('raises a validation error in the store for an out-of-range config', async () => {
    render(<ConfigEditor />);
    fireEvent.change(screen.getByLabelText('Duration (ms)'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply & reload' }));
    await waitFor(() => expect(useSimStore.getState().error).toBeTruthy());
    expect(useSimStore.getState().error).toMatch(/Too small|greater than|positive|>/i);
    expect(useSimStore.getState().ready).toBe(false);
  });

  it('raises a reload error when the worker rejects loadConfig (e.g. Envoy aborts)', async () => {
    const runner = attach();
    // Simulate the real failure mode: a schema-valid config that the worker
    // still rejects deep in the Wasm LB. The catch path must surface it.
    runner.loadConfig = () => Promise.reject(new Error('Maglev abort'));
    render(<ConfigEditor />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply & reload' }));
    await waitFor(() => expect(useSimStore.getState().error).toBeTruthy());
    expect(useSimStore.getState().error).toContain('Reload failed: Maglev abort');
    expect(useSimStore.getState().ready).toBe(false);
  });

  it('edits the ring_hash maximumRingSize and keeps the draft schema-valid', () => {
    render(<ConfigEditor />);
    fireEvent.change(screen.getByLabelText('LB policy'), { target: { value: 'ring_hash' } });
    fireEvent.change(screen.getByLabelText('Max ring'), { target: { value: '16384' } });
    expect(useSimStore.getState().config.envoys.policy).toMatchObject({
      maximumRingSize: 16384,
    });
    expect(safeParseSimConfig(useSimStore.getState().config).success).toBe(true);
  });

  describe('Backend processing time (latency distribution)', () => {
    it('renders a distribution kind Select for backend processing time', () => {
      render(<ConfigEditor />);
      expect(
        screen.getByLabelText('Backend processing time distribution kind'),
      ).toBeInTheDocument();
    });

    it('shows the current kind matching the default config latency', () => {
      render(<ConfigEditor />);
      const select = screen.getByLabelText(
        'Backend processing time distribution kind',
      ) as HTMLSelectElement;
      const defaultLatency = useSimStore.getState().config.backends.defaults.latency;
      expect(select.value).toBe(defaultLatency.kind);
    });

    it('changing kind to constant sets a valid constant latency and updates the store', () => {
      render(<ConfigEditor />);
      fireEvent.change(screen.getByLabelText('Backend processing time distribution kind'), {
        target: { value: 'constant' },
      });
      const latency = useSimStore.getState().config.backends.defaults.latency;
      expect(latency.kind).toBe('constant');
      expect('value' in latency && typeof latency.value === 'number').toBe(true);
      expect(safeParseSimConfig(useSimStore.getState().config).success).toBe(true);
    });

    it('changing kind to normal sets a valid normal latency with mean and stddev', () => {
      render(<ConfigEditor />);
      fireEvent.change(screen.getByLabelText('Backend processing time distribution kind'), {
        target: { value: 'normal' },
      });
      const latency = useSimStore.getState().config.backends.defaults.latency;
      expect(latency.kind).toBe('normal');
      expect('mean' in latency && 'stddev' in latency).toBe(true);
      expect(safeParseSimConfig(useSimStore.getState().config).success).toBe(true);
    });

    it('shows param fields for constant kind and editing value updates the store', () => {
      render(<ConfigEditor />);
      fireEvent.change(screen.getByLabelText('Backend processing time distribution kind'), {
        target: { value: 'constant' },
      });
      expect(screen.getByLabelText('Value (ms)')).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText('Value (ms)'), { target: { value: '25' } });
      const latency = useSimStore.getState().config.backends.defaults.latency;
      expect(latency.kind).toBe('constant');
      expect('value' in latency && latency.value).toBe(25);
      expect(safeParseSimConfig(useSimStore.getState().config).success).toBe(true);
    });

    it('shows param fields for normal kind and editing mean updates the store', () => {
      render(<ConfigEditor />);
      fireEvent.change(screen.getByLabelText('Backend processing time distribution kind'), {
        target: { value: 'normal' },
      });
      expect(screen.getByLabelText('Mean (ms)')).toBeInTheDocument();
      expect(screen.getByLabelText('Std dev (ms)')).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText('Mean (ms)'), { target: { value: '50' } });
      const latency = useSimStore.getState().config.backends.defaults.latency;
      expect(latency.kind).toBe('normal');
      expect('mean' in latency && latency.mean).toBe(50);
      expect(safeParseSimConfig(useSimStore.getState().config).success).toBe(true);
    });

    it('shows correct params for uniform kind', () => {
      render(<ConfigEditor />);
      fireEvent.change(screen.getByLabelText('Backend processing time distribution kind'), {
        target: { value: 'uniform' },
      });
      expect(screen.getByLabelText('Min (ms)')).toBeInTheDocument();
      expect(screen.getByLabelText('Max (ms)')).toBeInTheDocument();
      expect(safeParseSimConfig(useSimStore.getState().config).success).toBe(true);
    });

    it('shows correct params for exponential kind', () => {
      render(<ConfigEditor />);
      fireEvent.change(screen.getByLabelText('Backend processing time distribution kind'), {
        target: { value: 'exponential' },
      });
      expect(screen.getByLabelText('Rate (events/ms)')).toBeInTheDocument();
      expect(safeParseSimConfig(useSimStore.getState().config).success).toBe(true);
    });

    it('shows correct params for lognormal kind', () => {
      render(<ConfigEditor />);
      // default is already lognormal, so no kind change needed
      const latency = useSimStore.getState().config.backends.defaults.latency;
      if (latency.kind !== 'lognormal') {
        fireEvent.change(screen.getByLabelText('Backend processing time distribution kind'), {
          target: { value: 'lognormal' },
        });
      }
      expect(screen.getByLabelText('Mu')).toBeInTheDocument();
      expect(screen.getByLabelText('Sigma')).toBeInTheDocument();
      expect(safeParseSimConfig(useSimStore.getState().config).success).toBe(true);
    });

    it('shows correct params for pareto kind', () => {
      render(<ConfigEditor />);
      fireEvent.change(screen.getByLabelText('Backend processing time distribution kind'), {
        target: { value: 'pareto' },
      });
      expect(screen.getByLabelText('Scale (ms)')).toBeInTheDocument();
      expect(screen.getByLabelText('Shape')).toBeInTheDocument();
      expect(safeParseSimConfig(useSimStore.getState().config).success).toBe(true);
    });

    it('edits uniform min/max and keeps the draft valid', () => {
      render(<ConfigEditor />);
      fireEvent.change(screen.getByLabelText('Backend processing time distribution kind'), {
        target: { value: 'uniform' },
      });
      fireEvent.change(screen.getByLabelText('Min (ms)'), { target: { value: '3' } });
      fireEvent.change(screen.getByLabelText('Max (ms)'), { target: { value: '30' } });
      expect(useSimStore.getState().config.backends.defaults.latency).toMatchObject({
        kind: 'uniform',
        min: 3,
        max: 30,
      });
      expect(safeParseSimConfig(useSimStore.getState().config).success).toBe(true);
    });

    it('edits normal stddev and keeps the draft valid', () => {
      render(<ConfigEditor />);
      fireEvent.change(screen.getByLabelText('Backend processing time distribution kind'), {
        target: { value: 'normal' },
      });
      fireEvent.change(screen.getByLabelText('Std dev (ms)'), { target: { value: '4' } });
      expect(useSimStore.getState().config.backends.defaults.latency).toMatchObject({
        kind: 'normal',
        stddev: 4,
      });
      expect(safeParseSimConfig(useSimStore.getState().config).success).toBe(true);
    });

    it('edits exponential rate and keeps the draft valid', () => {
      render(<ConfigEditor />);
      fireEvent.change(screen.getByLabelText('Backend processing time distribution kind'), {
        target: { value: 'exponential' },
      });
      fireEvent.change(screen.getByLabelText('Rate (events/ms)'), { target: { value: '0.2' } });
      expect(useSimStore.getState().config.backends.defaults.latency).toMatchObject({
        kind: 'exponential',
        ratePerMs: 0.2,
      });
      expect(safeParseSimConfig(useSimStore.getState().config).success).toBe(true);
    });

    it('edits lognormal mu/sigma and keeps the draft valid', () => {
      render(<ConfigEditor />);
      // Default is lognormal already.
      fireEvent.change(screen.getByLabelText('Mu'), { target: { value: '2.5' } });
      fireEvent.change(screen.getByLabelText('Sigma'), { target: { value: '0.6' } });
      expect(useSimStore.getState().config.backends.defaults.latency).toMatchObject({
        kind: 'lognormal',
        mu: 2.5,
        sigma: 0.6,
      });
      expect(safeParseSimConfig(useSimStore.getState().config).success).toBe(true);
    });

    it('edits pareto scale/shape and keeps the draft valid', () => {
      render(<ConfigEditor />);
      fireEvent.change(screen.getByLabelText('Backend processing time distribution kind'), {
        target: { value: 'pareto' },
      });
      fireEvent.change(screen.getByLabelText('Scale (ms)'), { target: { value: '8' } });
      fireEvent.change(screen.getByLabelText('Shape'), { target: { value: '3' } });
      expect(useSimStore.getState().config.backends.defaults.latency).toMatchObject({
        kind: 'pareto',
        scale: 8,
        shape: 3,
      });
      expect(safeParseSimConfig(useSimStore.getState().config).success).toBe(true);
    });

    it('only shows param fields for the current kind (no cross-kind leakage)', () => {
      render(<ConfigEditor />);
      fireEvent.change(screen.getByLabelText('Backend processing time distribution kind'), {
        target: { value: 'constant' },
      });
      // constant fields visible, normal fields not
      expect(screen.getByLabelText('Value (ms)')).toBeInTheDocument();
      expect(screen.queryByLabelText('Mean (ms)')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Std dev (ms)')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Min (ms)')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Rate (events/ms)')).not.toBeInTheDocument();
    });
  });
});
