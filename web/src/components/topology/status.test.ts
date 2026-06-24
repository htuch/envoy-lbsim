import { describe, expect, it } from 'vitest';
import { statusBadge, utilizationColor } from './status';
import type { TopologyNodeStatus } from './types';

function node(partial: Partial<TopologyNodeStatus>): TopologyNodeStatus {
  return {
    kind: 'backend',
    index: 0,
    label: 'b0',
    inFlight: 0,
    queueDepth: 0,
    queueCapacity: 0,
    utilization: 0,
    health: 0,
    panic: false,
    region: 'r1',
    zone: 'z1',
    ...partial,
  };
}

describe('utilizationColor', () => {
  it('is green at no load and red at full load', () => {
    expect(utilizationColor(0)).toBe('hsl(140 72% 45%)');
    expect(utilizationColor(1)).toBe('hsl(0 72% 45%)');
  });

  it('clamps out-of-range values', () => {
    expect(utilizationColor(-1)).toBe(utilizationColor(0));
    expect(utilizationColor(2)).toBe(utilizationColor(1));
  });
});

describe('statusBadge', () => {
  it('labels backend health by ordinal', () => {
    expect(statusBadge(node({ kind: 'backend', health: 0 })).label).toBe('healthy');
    expect(statusBadge(node({ kind: 'backend', health: 1 })).label).toBe('degraded');
    expect(statusBadge(node({ kind: 'backend', health: 2 })).label).toBe('unhealthy');
    expect(statusBadge(node({ kind: 'backend', health: 3 })).label).toBe('draining');
  });

  it('flags Envoy panic, else reports active', () => {
    expect(statusBadge(node({ kind: 'envoy', panic: true })).label).toBe('panic');
    expect(statusBadge(node({ kind: 'envoy', panic: false })).label).toBe('active');
    expect(statusBadge(node({ kind: 'client' })).label).toBe('active');
  });
});
