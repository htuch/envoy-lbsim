import { describe, expect, it } from 'vitest';
import { TERMINAL_PHASES } from './events';
import { ENTITY_KINDS } from './ids';
import type { WindowLatencySamples } from './worker-rpc';

describe('protocol constants', () => {
  it('enumerates the entity kinds', () => {
    expect(ENTITY_KINDS).toEqual(['client', 'envoy', 'backend']);
  });

  it('marks the lifecycle-closing phases as terminal', () => {
    expect(TERMINAL_PHASES.has('completed')).toBe(true);
    expect(TERMINAL_PHASES.has('timed_out')).toBe(true);
    expect(TERMINAL_PHASES.has('rejected')).toBe(true);
    expect(TERMINAL_PHASES.has('emitted')).toBe(false);
  });
});

describe('contract types', () => {
  it('WindowLatencySamples is properly shaped', () => {
    const sample: WindowLatencySamples = {
      fromMs: 0,
      toMs: 1000,
      latencies: [10, 20, 30],
      capped: false,
    };

    expect(sample satisfies WindowLatencySamples).toBeTruthy();
    expect(sample.fromMs).toBe(0);
    expect(sample.toMs).toBe(1000);
    expect(sample.latencies).toEqual([10, 20, 30]);
    expect(sample.capped).toBe(false);
  });
});
