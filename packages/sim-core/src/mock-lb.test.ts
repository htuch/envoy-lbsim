import type { CommonLbConfig, EnvoyLbPolicy } from '@elbsim/config';
import type { WasmHost, WasmHostSet } from '@elbsim/protocol';
import { describe, expect, it } from 'vitest';
import { mockLbModule } from './mock-lb';

const common = {
  healthyPanicThresholdPercent: 50,
  overprovisioningFactor: 140,
  locality: { kind: 'none' },
} as CommonLbConfig;

function host(backend: number, health: 0 | 1 | 2 = 2): WasmHost {
  return { backend, weight: 1, health, priority: 0, region: 'r1', zone: 'z1', activeRequests: 0 };
}

const hostSet = (hosts: WasmHost[]): WasmHostSet => ({ hosts, overprovisioningFactor: 140 });

describe('mockLbModule', () => {
  it('round-robins over healthy hosts and skips unhealthy ones', () => {
    const lb = mockLbModule.createLb({ kind: 'round_robin' }, common, 1);
    lb.updateHosts(hostSet([host(0), host(1, 0), host(2)]));
    expect([lb.chooseHost({}), lb.chooseHost({}), lb.chooseHost({})]).toEqual([0, 2, 0]);
    lb.delete();
  });

  it('returns -1 when there are no healthy hosts', () => {
    const lb = mockLbModule.createLb(
      { kind: 'least_request', choiceCount: 2, activeRequestBias: 1, selectionMethod: 'n_choices' },
      common,
      1,
    );
    lb.updateHosts(hostSet([host(0, 0), host(1, 1)]));
    expect(lb.chooseHost({})).toBe(-1);
  });

  it('hash policies map a key deterministically onto the host set', () => {
    const policy: EnvoyLbPolicy = { kind: 'maglev', tableSize: 65537 };
    const lb = mockLbModule.createLb(policy, common, 1);
    lb.updateHosts(hostSet([host(10), host(11), host(12)]));
    expect(lb.chooseHost({ hashKey: 4 })).toBe(lb.chooseHost({ hashKey: 4 }));
    expect(lb.chooseHost({ hashKey: 1 })).toBe(11);
  });

  it('random policy picks a healthy host', () => {
    const lb = mockLbModule.createLb({ kind: 'random' }, common, 5);
    lb.updateHosts(hostSet([host(0), host(1)]));
    expect([0, 1]).toContain(lb.chooseHost({}));
  });

  it('reports no persistent structure', () => {
    const lb = mockLbModule.createLb({ kind: 'random' }, common, 1);
    expect(lb.inspect()).toEqual({ kind: 'none' });
  });
});
