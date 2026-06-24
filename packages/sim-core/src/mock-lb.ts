import type { CommonLbConfig, EnvoyLbPolicy } from '@elbsim/config';
import type {
  LbInstance,
  LbModule,
  LbStructure,
  WasmHostSet,
  WasmLbContext,
} from '@elbsim/protocol';
import { Prng } from './prng';

/**
 * A pure-TypeScript stand-in for the Wasm LB, implementing the same
 * {@link LbInstance} ABI. It lets the sim kernel (Track B) and the frontend
 * (Track C) develop and test against the real interface before the Wasm module
 * (Track A) lands. It is intentionally NOT a faithful Envoy implementation; it
 * is round-robin / hash-modulo over healthy hosts; and must never be shipped as
 * the production LB. Track A replaces it with real Envoy code in Wasm.
 */
class MockLbInstance implements LbInstance {
  private readonly policy: EnvoyLbPolicy;
  private readonly rng: Prng;
  private healthy: Array<{ backend: number; weight: number }> = [];
  private cursor = 0;

  constructor(policy: EnvoyLbPolicy, seed: number) {
    this.policy = policy;
    this.rng = new Prng(seed);
  }

  updateHosts(set: WasmHostSet): void {
    this.healthy = set.hosts
      .filter((h) => h.health === 2)
      .map((h) => ({ backend: h.backend, weight: h.weight }));
    this.cursor = 0;
  }

  chooseHost(ctx: WasmLbContext): number {
    const hosts = this.healthy;
    if (hosts.length === 0) return -1;
    switch (this.policy.kind) {
      case 'maglev':
      case 'ring_hash': {
        const key = ctx.hashKey ?? 0;
        return (hosts[key % hosts.length] as { backend: number }).backend;
      }
      case 'random':
        return (hosts[this.rng.nextInt(hosts.length)] as { backend: number }).backend;
      default: {
        const picked = hosts[this.cursor % hosts.length] as { backend: number };
        this.cursor++;
        return picked.backend;
      }
    }
  }

  inspect(): LbStructure {
    return { kind: 'none' };
  }

  delete(): void {
    this.healthy = [];
  }
}

/** A {@link LbModule} backed by the mock instance above. */
export const mockLbModule: LbModule = {
  createLb(policy: EnvoyLbPolicy, _common: CommonLbConfig, seed: number): LbInstance {
    return new MockLbInstance(policy, seed);
  },
};
