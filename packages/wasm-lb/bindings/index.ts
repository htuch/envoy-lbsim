/**
 * TypeScript loader and adapter for the Wasm LB module.
 *
 * The Emscripten artifact (built by the package Makefile to `build/lb.mjs`)
 * exposes Envoy's real load-balancer structures over a small Embind surface.
 * This module wraps that surface in the durable {@link LbModule} / {@link LbInstance}
 * contract from `@elbsim/protocol`: the kernel translates a `SimConfig` slice and
 * a resolved host set into the flat arrays the Embind ABI consumes, and reads back
 * picks and inspection payloads. Host-set resolution (health/locality/panic) is
 * the kernel's job (see ARCHITECTURE.md), so we filter to eligible hosts here and
 * hand the policy a clean set, mirroring what Envoy's LB base would pass.
 */
import type { CommonLbConfig, EnvoyLbPolicy } from '@elbsim/config';
import type {
  BackendId,
  LbInstance,
  LbModule,
  LbStructure,
  WasmHostSet,
  WasmLbContext,
} from '@elbsim/protocol';

/** Minimal Embind vector surface Emscripten generates for register_vector. */
export interface EmbindVector<T> {
  push_back(value: T): void;
  size(): number;
  get(index: number): T;
  delete(): void;
}

/** One real Envoy LB instance as Embind exposes it (raw-pointer handle). */
interface EmbindLb {
  updateHosts(backends: EmbindVector<number>, weights: EmbindVector<number>): void;
  chooseHost(hash: number): number;
  inspect(): LbStructure;
  delete(): void;
}

/** The Embind module surface emitted by `src/lb.cpp`. */
export interface WasmLbModule {
  VectorInt: new () => EmbindVector<number>;
  VectorDouble: new () => EmbindVector<number>;
  createMaglevLb(tableSize: number, useHostname: boolean): EmbindLb;
}

type WasmLbModuleFactory = () => Promise<WasmLbModule>;

/** Relative path (from this file) to the built Emscripten ES module. */
export const ARTIFACT_URL = new URL('../build/lb.mjs', import.meta.url);

/** Health ordinal for a healthy host (Envoy Host::Health). */
const HEALTH_HEALTHY = 2;

/**
 * Resolve the host set the policy should balance over. Mirrors Envoy's behavior:
 * normally the healthy hosts; if none are healthy the LB falls into panic mode
 * and routes across all hosts rather than dropping traffic.
 */
function eligibleHosts(set: WasmHostSet): WasmHostSet['hosts'] {
  const healthy = set.hosts.filter((h) => h.health === HEALTH_HEALTHY);
  return healthy.length > 0 ? healthy : set.hosts;
}

// The loaded Embind module, shared by all instances (one Wasm module, many LBs).
let wasmModule: WasmLbModule | undefined;

/** Wrap an Embind LB handle in the protocol's {@link LbInstance}. */
function adapt(mod: WasmLbModule, lb: EmbindLb): LbInstance {
  return {
    updateHosts(set: WasmHostSet): void {
      const hosts = eligibleHosts(set);
      const backends = new mod.VectorInt();
      const weights = new mod.VectorDouble();
      try {
        for (const h of hosts) {
          backends.push_back(h.backend);
          weights.push_back(h.weight);
        }
        lb.updateHosts(backends, weights);
      } finally {
        backends.delete();
        weights.delete();
      }
    },
    chooseHost(ctx: WasmLbContext): BackendId {
      return lb.chooseHost(ctx.hashKey ?? 0) as BackendId;
    },
    inspect(): LbStructure {
      return lb.inspect();
    },
    delete(): void {
      lb.delete();
    },
  };
}

/**
 * Load the compiled Wasm LB and return a {@link LbModule}. Throws a clear error if
 * the artifact has not been built (run `pnpm --filter @elbsim/wasm-lb build`,
 * which needs an activated emsdk).
 */
export async function loadLbModule(): Promise<LbModule> {
  if (!wasmModule) {
    let factory: WasmLbModuleFactory;
    try {
      ({ default: factory } = (await import(ARTIFACT_URL.href)) as {
        default: WasmLbModuleFactory;
      });
    } catch (cause) {
      throw new Error(
        'wasm-lb artifact not built; run `pnpm --filter @elbsim/wasm-lb build` (needs emsdk)',
        { cause },
      );
    }
    wasmModule = await factory();
  }

  const mod = wasmModule;
  return {
    createLb(policy: EnvoyLbPolicy, _common: CommonLbConfig, _seed: number): LbInstance {
      switch (policy.kind) {
        case 'maglev':
          return adapt(mod, mod.createMaglevLb(policy.tableSize, false));
        default:
          // ring_hash and the EDF-base policies (round_robin/least_request/random)
          // are not lifted yet; the kernel uses its mock for those until they land.
          throw new Error(`Wasm LB policy '${policy.kind}' is not yet implemented`);
      }
    },
  };
}
