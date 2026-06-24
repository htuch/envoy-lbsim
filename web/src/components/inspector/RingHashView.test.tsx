import { parseSimConfig } from '@elbsim/config';
import type { RingHashInspection } from '@elbsim/protocol';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSimStore } from '@/store/sim-store';
import { RingHashView } from './RingHashView';

/**
 * Unit tests for RingHashView.
 *
 * The component reads ring_hash bounds (minimumRingSize / maximumRingSize) from
 * the store config, so we seed the store with a ring_hash policy before each
 * test and reset afterwards.
 */

const RING_CONFIG = parseSimConfig({
  version: 1,
  seed: 7,
  time: { durationMs: 60_000, sampleIntervalMs: 10 },
  clients: {
    count: 4,
    arrival: { kind: 'poisson', ratePerSec: 20 },
    requestKey: { kind: 'zipf', n: 1_000, s: 1.1 },
    lb: { kind: 'round_robin' },
  },
  network: {
    clientToEnvoy: { kind: 'normal', mean: 2, stddev: 0.5 },
    envoyToBackend: { kind: 'normal', mean: 1, stddev: 0.25 },
    crossZonePenaltyMs: 3,
  },
  envoys: {
    count: 2,
    policy: { kind: 'ring_hash', minimumRingSize: 2048, maximumRingSize: 8192 },
    queue: { maxConcurrentRequests: 64, queueCapacity: 256 },
  },
  backends: {
    count: 3,
    defaults: {
      capacity: 12,
      latency: { kind: 'lognormal', mu: 2.3, sigma: 0.4 },
      queueSize: 24,
    },
    overrides: {},
  },
  timeouts: { requestTimeoutMs: 250, retries: 0 },
});

/** A small RingHashInspection with size=2048 and a few entries for the legend. */
const RING_INSPECTION: RingHashInspection = {
  kind: 'ring',
  size: 2048,
  entries: [
    { hash: '0000000000000001', backend: 0 },
    { hash: '5555555555555555', backend: 1 },
    { hash: 'aaaaaaaaaaaaaaaa', backend: 2 },
    { hash: 'ffffffffffff0000', backend: 0 },
  ],
};

describe('RingHashView', () => {
  beforeEach(() => {
    useSimStore.setState(useSimStore.getInitialState(), true);
    useSimStore.getState().setConfig(RING_CONFIG);
  });

  afterEach(() => {
    useSimStore.setState(useSimStore.getInitialState(), true);
  });

  it('renders "sampled at" with the correct ring size', () => {
    render(<RingHashView ring={RING_INSPECTION} />);
    expect(screen.getByText(/sampled at/)).toBeInTheDocument();
    // 2048 appears twice: once in "sampled at" and once in "configured min".
    expect(screen.getAllByText('2048').length).toBeGreaterThanOrEqual(1);
  });

  it('renders "configured min" with minimumRingSize and maximumRingSize', () => {
    render(<RingHashView ring={RING_INSPECTION} />);
    expect(screen.getByText(/configured min/)).toBeInTheDocument();
    // Both bound values must appear: min (2048, shared with "sampled at") and max.
    expect(screen.getAllByText('2048').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('8192')).toBeInTheDocument();
  });

  it('does not contain the literal text "ring size"', () => {
    render(<RingHashView ring={RING_INSPECTION} />);
    // The label was changed from "ring size" to "sampled at N points"; confirm
    // the old label is gone.
    expect(screen.queryByText(/ring size/i)).not.toBeInTheDocument();
  });
});
