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
  /**
   * Hand the full resolved host set to the real Envoy base as parallel arrays.
   * The base does the health/priority/locality/panic resolution itself, so we
   * pass every host with its health ordinal, priority, and locality, not a
   * pre-filtered list.
   */
  updateHosts(
    backends: EmbindVector<number>,
    weights: EmbindVector<number>,
    healths: EmbindVector<number>,
    priorities: EmbindVector<number>,
    regions: EmbindVector<string>,
    zones: EmbindVector<string>,
    activeRequests: EmbindVector<number>,
  ): void;
  chooseHost(hash: number): number;
  inspect(): LbStructure;
  delete(): void;
}

/** The Embind module surface emitted by `src/lb.cpp`. */
export interface WasmLbModule {
  VectorInt: new () => EmbindVector<number>;
  VectorDouble: new () => EmbindVector<number>;
  VectorString: new () => EmbindVector<string>;
  createMaglevLb(
    tableSize: number,
    useHostname: boolean,
    healthyPanicThreshold: number,
    overprovisioningFactor: number,
    seed: number,
  ): EmbindLb;
  createRingHashLb(
    minimumRingSize: number,
    maximumRingSize: number,
    hashFunction: number,
    useHostname: boolean,
    healthyPanicThreshold: number,
    overprovisioningFactor: number,
    seed: number,
  ): EmbindLb;
  createRoundRobinLb(
    healthyPanicThreshold: number,
    overprovisioningFactor: number,
    seed: number,
  ): EmbindLb;
  createLeastRequestLb(
    choiceCount: number,
    activeRequestBias: number,
    selectionMethod: number,
    healthyPanicThreshold: number,
    overprovisioningFactor: number,
    seed: number,
  ): EmbindLb;
  createRandomLb(
    healthyPanicThreshold: number,
    overprovisioningFactor: number,
    seed: number,
  ): EmbindLb;
}

/** Embind enum ordinals for the ring_hash hash function (proto HashFunction). */
const RING_HASH_FUNCTION = { xx_hash: 1, murmur_hash_2: 2 } as const;

/** Embind enum ordinals for the least_request selection method (proto SelectionMethod). */
const SELECTION_METHOD = { n_choices: 0, full_scan: 1 } as const;

type WasmLbModuleFactory = () => Promise<WasmLbModule>;

/** Relative path (from this file) to the built Emscripten ES module. */
export const ARTIFACT_URL = new URL('../build/lb.mjs', import.meta.url);

// The loaded Embind module, shared by all instances (one Wasm module, many LBs).
let wasmModule: WasmLbModule | undefined;

/** Wrap an Embind LB handle in the protocol's {@link LbInstance}. */
function adapt(mod: WasmLbModule, lb: EmbindLb): LbInstance {
  return {
    updateHosts(set: WasmHostSet): void {
      const backends = new mod.VectorInt();
      const weights = new mod.VectorDouble();
      const healths = new mod.VectorInt();
      const priorities = new mod.VectorInt();
      const regions = new mod.VectorString();
      const zones = new mod.VectorString();
      const activeRequests = new mod.VectorInt();
      try {
        // Pass the full set; the real Envoy base partitions by health/priority and
        // applies panic/locality itself. activeRequests feeds the lifted base's
        // host.stats().rq_active_, which least_request reads at pick time.
        for (const h of set.hosts) {
          backends.push_back(h.backend);
          weights.push_back(h.weight);
          healths.push_back(h.health);
          priorities.push_back(h.priority);
          regions.push_back(h.region);
          zones.push_back(h.zone);
          activeRequests.push_back(h.activeRequests);
        }
        lb.updateHosts(backends, weights, healths, priorities, regions, zones, activeRequests);
      } finally {
        for (const v of [backends, weights, healths, priorities, regions, zones, activeRequests])
          v.delete();
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
    createLb(policy: EnvoyLbPolicy, common: CommonLbConfig, seed: number): LbInstance {
      switch (policy.kind) {
        case 'maglev':
          return adapt(
            mod,
            mod.createMaglevLb(
              policy.tableSize,
              false,
              common.healthyPanicThresholdPercent,
              common.overprovisioningFactor,
              seed,
            ),
          );
        case 'ring_hash':
          return adapt(
            mod,
            mod.createRingHashLb(
              policy.minimumRingSize,
              policy.maximumRingSize,
              RING_HASH_FUNCTION[policy.hashFunction],
              policy.useHostnameForHashing,
              common.healthyPanicThresholdPercent,
              common.overprovisioningFactor,
              seed,
            ),
          );
        case 'round_robin':
          return adapt(
            mod,
            mod.createRoundRobinLb(
              common.healthyPanicThresholdPercent,
              common.overprovisioningFactor,
              seed,
            ),
          );
        case 'least_request':
          return adapt(
            mod,
            mod.createLeastRequestLb(
              policy.choiceCount,
              policy.activeRequestBias,
              SELECTION_METHOD[policy.selectionMethod],
              common.healthyPanicThresholdPercent,
              common.overprovisioningFactor,
              seed,
            ),
          );
        case 'random':
          return adapt(
            mod,
            mod.createRandomLb(
              common.healthyPanicThresholdPercent,
              common.overprovisioningFactor,
              seed,
            ),
          );
        default: {
          // Exhaustive: every EnvoyLbPolicy kind is lifted. If a new kind is added
          // to the config, this fails to type-check until it is handled here.
          const unhandled: never = policy;
          throw new Error(`unhandled Wasm LB policy '${(unhandled as { kind: string }).kind}'`);
        }
      }
    },
  };
}
