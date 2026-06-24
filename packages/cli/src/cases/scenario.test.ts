import { describe, expect, it } from 'vitest';
import { scenario } from './scenario';

describe('scenario', () => {
  it('builds a valid SimConfig for a policy with sane defaults', () => {
    const cfg = scenario('maglev');
    expect(cfg.envoys.policy.kind).toBe('maglev');
    expect(cfg.backends.count).toBe(6);
    expect(cfg.time.durationMs).toBe(5_000);
  });

  it('applies backend overrides (e.g. an unhealthy host)', () => {
    const cfg = scenario('round_robin', {
      backends: 4,
      overrides: { '0': { health: 'unhealthy' } },
    });
    expect(cfg.backends.count).toBe(4);
    expect(cfg.backends.overrides['0']?.health).toBe('unhealthy');
  });

  it('is deterministic in shape across calls', () => {
    expect(scenario('random')).toEqual(scenario('random'));
  });
});
