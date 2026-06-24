import { defaultSimConfig, parseSimConfig, type SimConfig } from '@elbsim/config';
import { describe, expect, it } from 'vitest';
import { fillMaglevTable, makeInspection } from './inspection';

function configWith(overrides: Record<string, unknown>): SimConfig {
  return parseSimConfig({ ...defaultSimConfig(), ...overrides });
}

describe('makeInspection', () => {
  it('is deterministic for the same (config, envoy, t)', () => {
    const config = defaultSimConfig();
    expect(makeInspection(config, 1, 2000)).toEqual(makeInspection(config, 1, 2000));
  });

  it('produces one resolved host per backend with valid fields', () => {
    const config = defaultSimConfig();
    const insp = makeInspection(config, 0, 0);
    expect(insp.hosts).toHaveLength(config.backends.count);
    for (const h of insp.hosts) {
      expect([0, 1, 2]).toContain(h.health);
      expect(h.weight).toBeGreaterThan(0);
      expect(h.activeRequests).toBeGreaterThanOrEqual(0);
    }
  });

  it('defaults the structure kind to the configured policy', () => {
    const config = configWith({
      envoys: { count: 2, policy: { kind: 'ring_hash' }, queue: { maxConcurrentRequests: 16 } },
    });
    expect(makeInspection(config, 0, 0).structure.kind).toBe('ring');
  });

  it('renders an EDF heap sorted by ascending deadline', () => {
    const config = configWith({
      envoys: { count: 2, policy: { kind: 'round_robin' }, queue: { maxConcurrentRequests: 16 } },
    });
    const struct = makeInspection(config, 0, 0).structure;
    if (struct.kind !== 'edf') throw new Error('expected edf');
    for (let i = 1; i < struct.entries.length; i++) {
      expect(struct.entries[i]!.deadline).toBeGreaterThanOrEqual(struct.entries[i - 1]!.deadline);
    }
  });

  it('fills the Maglev table so slot counts sum to the table size', () => {
    const config = configWith({
      envoys: {
        count: 2,
        policy: { kind: 'maglev', tableSize: 1009 },
        queue: { maxConcurrentRequests: 16 },
      },
    });
    const struct = makeInspection(config, 0, 0).structure;
    if (struct.kind !== 'maglev') throw new Error('expected maglev');
    expect(struct.tableSize).toBe(1009);
    expect(struct.table).toHaveLength(1009);
    const summed = Object.values(struct.slotCounts).reduce((a, b) => a + b, 0);
    expect(summed).toBe(1009);
  });

  it('renders a hash ring sorted ascending by hash', () => {
    const config = configWith({
      envoys: {
        count: 2,
        policy: { kind: 'ring_hash', minimumRingSize: 64 },
        queue: { maxConcurrentRequests: 16 },
      },
    });
    const struct = makeInspection(config, 0, 0).structure;
    if (struct.kind !== 'ring') throw new Error('expected ring');
    expect(struct.size).toBe(struct.entries.length);
    for (let i = 1; i < struct.entries.length; i++) {
      expect(struct.entries[i]!.hash >= struct.entries[i - 1]!.hash).toBe(true);
    }
  });

  it('reports a stateless structure for random', () => {
    const config = configWith({
      envoys: { count: 2, policy: { kind: 'random' }, queue: { maxConcurrentRequests: 16 } },
    });
    expect(makeInspection(config, 0, 0).structure.kind).toBe('none');
  });

  it('honors an explicit policyKind override to exercise any structure', () => {
    const config = defaultSimConfig(); // configured policy is maglev
    expect(makeInspection(config, 0, 0, 'ring_hash').structure.kind).toBe('ring');
    expect(makeInspection(config, 0, 0, 'round_robin').structure.kind).toBe('edf');
    expect(makeInspection(config, 0, 0, 'random').structure.kind).toBe('none');
  });

  it('falls back to default table/ring sizes when the policy config differs', () => {
    // Base policy is round_robin, so the maglev/ring overrides take the default
    // table size (65537) and minimum ring size (1024) branches.
    const config = configWith({
      envoys: { count: 2, policy: { kind: 'round_robin' }, queue: { maxConcurrentRequests: 16 } },
    });
    const maglev = makeInspection(config, 0, 0, 'maglev').structure;
    if (maglev.kind !== 'maglev') throw new Error('expected maglev');
    expect(maglev.tableSize).toBe(65537);
    const ring = makeInspection(config, 0, 0, 'ring_hash').structure;
    if (ring.kind !== 'ring') throw new Error('expected ring');
    expect(ring.size).toBeGreaterThanOrEqual(1024);
  });

  it('carries per-backend locality overrides into the resolved hosts', () => {
    const config = configWith({
      backends: {
        count: 2,
        defaults: { capacity: 8, latency: { kind: 'constant', value: 5 } },
        overrides: { '1': { locality: { region: 'r3', zone: 'z7' } } },
      },
    });
    const insp = makeInspection(config, 0, 0);
    expect(insp.hosts[1]).toMatchObject({ region: 'r3', zone: 'z7' });
  });
});

describe('fillMaglevTable', () => {
  it('returns an empty table when there are no backends', () => {
    const { table, slotCounts } = fillMaglevTable([], [], 11);
    expect(table).toHaveLength(11);
    expect(Array.from(table)).toEqual(new Array(11).fill(0));
    expect(slotCounts).toEqual({});
  });

  it('distributes slots in proportion to weight', () => {
    const { slotCounts } = fillMaglevTable([0, 1], [3, 1], 1024);
    expect(slotCounts[0]! + slotCounts[1]!).toBe(1024);
    // Backend 0 (weight 3 of 4) takes roughly three quarters of the slots.
    expect(slotCounts[0]! / 1024).toBeCloseTo(0.75, 1);
  });

  it('weights Maglev slot shares and ring points by backend weight', () => {
    const config = configWith({
      envoys: {
        count: 2,
        policy: { kind: 'maglev', tableSize: 1201 },
        queue: { maxConcurrentRequests: 16 },
      },
      backends: {
        count: 3,
        defaults: { capacity: 8, latency: { kind: 'constant', value: 5 } },
        overrides: { '0': { weight: 3 } },
      },
    });
    // Find an instant where every host is live so weights drive the shares.
    for (let t = 0; t < 200; t++) {
      const insp = makeInspection(config, 0, t);
      if (insp.hosts.some((h) => h.health === 0)) continue;
      const struct = insp.structure;
      if (struct.kind !== 'maglev') throw new Error('expected maglev');
      // Backend 0 (weight 3 of total 5) holds the largest slot share.
      const shares = struct.slotCounts;
      expect(shares[0]!).toBeGreaterThan(shares[1]!);
      expect(shares[0]!).toBeGreaterThan(shares[2]!);
      return;
    }
    throw new Error('no fully-healthy instant found');
  });

  it('exercises every health level and panic across many instants', () => {
    const config = configWith({
      envoys: {
        count: 2,
        policy: { kind: 'least_request' },
        queue: { maxConcurrentRequests: 16 },
        common: { healthyPanicThresholdPercent: 90 },
      },
      backends: { count: 6, defaults: { capacity: 8, latency: { kind: 'constant', value: 5 } } },
    });
    let sawHealthy = false;
    let sawDegraded = false;
    let sawUnhealthy = false;
    let sawPanic = false;
    let sawCalm = false;
    for (let t = 0; t < 300; t++) {
      const insp = makeInspection(config, t % 2, t);
      for (const h of insp.hosts) {
        if (h.health === 2) sawHealthy = true;
        if (h.health === 1) sawDegraded = true;
        if (h.health === 0) sawUnhealthy = true;
      }
      sawPanic ||= insp.panic;
      sawCalm ||= !insp.panic;
    }
    expect(sawHealthy && sawDegraded && sawUnhealthy).toBe(true);
    expect(sawPanic && sawCalm).toBe(true);
  });

  it('excludes unhealthy hosts from the EDF heap', () => {
    const config = configWith({
      envoys: { count: 2, policy: { kind: 'round_robin' }, queue: { maxConcurrentRequests: 16 } },
      backends: { count: 6, defaults: { capacity: 8, latency: { kind: 'constant', value: 5 } } },
    });
    for (let t = 0; t < 200; t++) {
      const insp = makeInspection(config, 0, t);
      const unhealthy = insp.hosts.filter((h) => h.health === 0).map((h) => h.backend);
      if (unhealthy.length === 0) continue;
      const struct = insp.structure;
      if (struct.kind !== 'edf') throw new Error('expected edf');
      for (const e of struct.entries) expect(unhealthy).not.toContain(e.backend);
      return;
    }
    throw new Error('no instant with an unhealthy host found');
  });

  it('flags panic when healthy hosts fall below the configured threshold', () => {
    // Force all hosts unhealthy is not directly controllable, but a 100% panic
    // threshold means anything short of fully healthy trips panic.
    const config = configWith({
      envoys: {
        count: 1,
        policy: { kind: 'maglev' },
        queue: { maxConcurrentRequests: 16 },
        common: { healthyPanicThresholdPercent: 100 },
      },
    });
    // Sweep instants until we observe at least one panic and one non-panic.
    let sawPanic = false;
    let sawCalm = false;
    for (let t = 0; t < 200 && !(sawPanic && sawCalm); t++) {
      const p = makeInspection(config, 0, t).panic;
      sawPanic ||= p;
      sawCalm ||= !p;
    }
    expect(sawPanic).toBe(true);
  });
});
