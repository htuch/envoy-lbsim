import { defaultSimConfig } from '@elbsim/config';
import { mockLbModule } from '@elbsim/sim-core';
import { describe, expect, it } from 'vitest';
import { runScenario } from './driver';

describe('runScenario', () => {
  const cfg = { ...defaultSimConfig(), time: { durationMs: 2_000, sampleIntervalMs: 50 } };

  it('runs to completion and returns a non-empty deterministic event stream', () => {
    const a = runScenario(cfg, { module: mockLbModule, label: 'mock' });
    const b = runScenario(cfg, { module: mockLbModule, label: 'mock' });
    expect(a.lbLabel).toBe('mock');
    expect(a.events.length).toBeGreaterThan(0);
    expect(a.events.length).toBe(b.events.length);
    expect(a.events.some((e) => e.phase === 'lb_pick')).toBe(true);
  });
});
