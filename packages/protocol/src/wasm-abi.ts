import type { CommonLbConfig, EnvoyLbPolicy } from '@elbsim/config';
import type { BackendId } from './ids';
import type { LbStructure } from './inspection';

/**
 * TypeScript view of the Wasm LB module's Embind ABI.
 *
 * This is the durable boundary between the sim kernel (TS) and the real Envoy LB
 * compiled to Wasm (Track A). Config crosses as flat plain objects/structs; no
 * protobuf; derived from `@elbsim/config`. One {@link LbInstance} corresponds
 * to one Envoy replica's load balancer; the kernel drives it per request.
 */

/** A backend host as handed to the LB, mirroring Envoy's Host fields. */
export interface WasmHost {
  backend: BackendId;
  weight: number;
  health: 0 | 1 | 2; // unhealthy | degraded | healthy
  priority: number;
  region: string;
  zone: string;
  activeRequests: number;
}

/** The full host set across priority levels for one cluster update. */
export interface WasmHostSet {
  hosts: WasmHost[];
  /** Overprovisioning factor copied from CommonLbConfig (e.g. 140). */
  overprovisioningFactor: number;
}

/** Per-request inputs Envoy's LoadBalancerContext would supply. */
export interface WasmLbContext {
  /** Hash key for consistent-hash policies; omit for non-hashed policies. */
  hashKey?: number;
  /** Caller locality, for zone-aware routing. */
  region?: string;
  zone?: string;
}

/** One Envoy replica's load balancer, backed by real Envoy C++ in Wasm. */
export interface LbInstance {
  /** Rebuild/refresh internal structures for a new host set (membership change). */
  updateHosts(set: WasmHostSet): void;
  /** Choose a backend for a request; returns the backend id, or -1 if none. */
  chooseHost(ctx: WasmLbContext): BackendId;
  /** Serialize the live internal structures for the inspector. */
  inspect(): LbStructure;
  /** Free the underlying Wasm object. */
  delete(): void;
}

/** Factory for LB instances; one per policy configuration. */
export interface LbModule {
  createLb(policy: EnvoyLbPolicy, common: CommonLbConfig, seed: number): LbInstance;
}

/** Shape of the async loader emitted by the Emscripten ES module build. */
export type LbModuleFactory = () => Promise<LbModule>;
