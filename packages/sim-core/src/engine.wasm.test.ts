import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSimConfig, type SimConfig } from '@elbsim/config';
import type { LbModule, RequestEvent } from '@elbsim/protocol';
import { ARTIFACT_URL, loadLbModule } from '@elbsim/wasm-lb';
import { beforeAll, describe, expect, it } from 'vitest';
import { SimEngine } from './engine';

/**
 * Integration: drive the real discrete-event kernel with the REAL Envoy load
 * balancers compiled to Wasm (not the TS mock). This proves the engine builds the
 * host set from sim state, calls updateHosts/chooseHost per request across the ABI,
 * and routes through Envoy's own C++ for every in-scope policy -- the same code the
 * `@elbsim/wasm-lb` golden node tests check at the Embind level, here exercised end
 * to end through `SimEngine`.
 *
 * The whole suite is skipped when the Wasm artifact is not built: the TS CI job
 * does not build it (the dedicated wasm job does), mirroring the golden node tests
 * so `pnpm -r test` stays green without emsdk.
 */
const HAS_ARTIFACT = existsSync(fileURLToPath(ARTIFACT_URL));

type RawConfig = Record<string, unknown> & { version: 1 };

function makeConfig(envoyPolicy: unknown): SimConfig {
  return parseSimConfig({
    version: 1,
    seed: 7,
    time: { durationMs: 400, sampleIntervalMs: 20 },
    clients: {
      count: 3,
      arrival: { kind: 'periodic', ratePerSec: 200 },
      requestKey: { kind: 'uniform', n: 64 },
      lb: { kind: 'round_robin' },
    },
    network: {
      clientToEnvoy: { kind: 'constant', value: 1 },
      envoyToBackend: { kind: 'constant', value: 1 },
    },
    envoys: { count: 2, policy: envoyPolicy, queue: { maxConcurrentRequests: 100 } },
    backends: { count: 5, defaults: { capacity: 100, latency: { kind: 'constant', value: 5 } } },
    timeouts: { requestTimeoutMs: 1000 },
  } satisfies RawConfig);
}

function picks(events: readonly RequestEvent[]) {
  return events.filter(
    (e): e is Extract<RequestEvent, { phase: 'lb_pick' }> => e.phase === 'lb_pick',
  );
}

const POLICIES = [
  { name: 'round_robin', policy: { kind: 'round_robin' }, structure: 'edf' },
  {
    name: 'least_request',
    policy: {
      kind: 'least_request',
      choiceCount: 2,
      activeRequestBias: 1,
      selectionMethod: 'n_choices',
    },
    structure: 'edf',
  },
  { name: 'random', policy: { kind: 'random' }, structure: 'none' },
  {
    name: 'ring_hash',
    policy: {
      kind: 'ring_hash',
      minimumRingSize: 1024,
      maximumRingSize: 8_388_608,
      hashFunction: 'xx_hash',
      useHostnameForHashing: false,
    },
    structure: 'ring',
  },
  { name: 'maglev', policy: { kind: 'maglev', tableSize: 65_537 }, structure: 'maglev' },
] as const;

describe.skipIf(!HAS_ARTIFACT)('SimEngine driven by the real Wasm LbModule', () => {
  let lbModule: LbModule;
  beforeAll(async () => {
    lbModule = await loadLbModule();
  });

  describe.each(POLICIES)('$name', ({ policy, structure }) => {
    it('routes every request to a valid backend and runs to completion', () => {
      const config = makeConfig(policy);
      const engine = new SimEngine(config, { lbModule });
      engine.runToCompletion();

      const lbPicks = picks(engine.events);
      expect(lbPicks.length).toBeGreaterThan(0);
      expect(lbPicks.every((e) => e.backend >= 0 && e.backend < config.backends.count)).toBe(true);
      expect(engine.events.some((e) => e.phase === 'completed')).toBe(true);
    });

    it('is deterministic from the seed', () => {
      const config = makeConfig(policy);
      const a = new SimEngine(config, { lbModule });
      const b = new SimEngine(config, { lbModule });
      a.runToCompletion();
      b.runToCompletion();
      expect(picks(a.events).map((e) => e.backend)).toEqual(picks(b.events).map((e) => e.backend));
    });

    it('serializes the real LB structure for the inspector', () => {
      const engine = new SimEngine(makeConfig(policy), { lbModule });
      engine.runUntil(100);
      expect(engine.inspect(0).structure.kind).toBe(structure);
    });
  });

  // Regression: the kernel must feed a full 64-bit hash to consistent-hash
  // policies. ring_hash treats the value as a ring position, so a raw small key
  // would collapse all traffic onto one host. With Prng.hash64 spreading the
  // key, distinct keys must reach more than one backend.
  it('ring_hash spreads distinct keys across multiple backends', () => {
    const config = makeConfig({
      kind: 'ring_hash',
      minimumRingSize: 1024,
      maximumRingSize: 8_388_608,
      hashFunction: 'xx_hash',
      useHostnameForHashing: false,
    });
    const engine = new SimEngine(config, { lbModule });
    engine.runToCompletion();
    const backends = new Set(picks(engine.events).map((e) => e.backend));
    expect(backends.size).toBeGreaterThan(1);
  });
});
