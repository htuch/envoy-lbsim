import { z } from 'zod';
import { Distribution, KeyDistribution } from './distributions';
import { ClientLbPolicy, CommonLbConfig, EnvoyLbPolicy } from './lb-policies';

/**
 * The simulated entities: M clients, N Envoy replicas, P backends, plus the
 * network links and timeouts that connect them. Counts are scalar so a topology
 * scales by a single number; per-instance heterogeneity is expressed with a
 * `defaults` spec plus sparse `overrides` keyed by instance index.
 */

/** A locality (region/zone) tag used for zone-aware and locality-weighted LB. */
export const Locality = z.object({
  region: z.string().default('r1'),
  zone: z.string().default('z1'),
});
export type Locality = z.infer<typeof Locality>;

// --- Clients (open-loop load generators) -------------------------------------

/** How a client emits requests over virtual time (open loop: no response wait). */
export const ArrivalProcess = z.discriminatedUnion('kind', [
  /** Poisson process with the given mean rate (requests/sec per client). */
  z.object({ kind: z.literal('poisson'), ratePerSec: z.number().positive() }),
  /** Evenly spaced emissions (requests/sec per client). */
  z.object({ kind: z.literal('periodic'), ratePerSec: z.number().positive() }),
  /** Uniform jitter around a mean rate. */
  z.object({
    kind: z.literal('uniform'),
    ratePerSec: z.number().positive(),
    jitterPercent: z.number().min(0).max(100).default(0),
  }),
]);
export type ArrivalProcess = z.infer<typeof ArrivalProcess>;

export const ClientPool = z.object({
  count: z.number().int().positive(),
  arrival: ArrivalProcess,
  /** Which resource/key each request targets (input to hash-based LB). */
  requestKey: KeyDistribution,
  /** How clients spread requests across the Envoy replicas. */
  lb: ClientLbPolicy,
  locality: Locality.default({ region: 'r1', zone: 'z1' }),
});
export type ClientPool = z.infer<typeof ClientPool>;

// --- Envoy replicas ----------------------------------------------------------

/** The Envoy-side admission/queue model in front of the upstream cluster. */
export const EnvoyQueueModel = z.object({
  /** Max concurrent in-flight upstream requests (circuit-breaker style). */
  maxConcurrentRequests: z.number().int().positive(),
  /** Pending queue capacity once concurrency is saturated; 0 = reject immediately. */
  queueCapacity: z.number().int().nonnegative().default(0),
  discipline: z.enum(['fifo', 'lifo']).default('fifo'),
});
export type EnvoyQueueModel = z.infer<typeof EnvoyQueueModel>;

export const EnvoyPool = z.object({
  count: z.number().int().positive(),
  /** The Envoy upstream load balancer policy (runs in Wasm). */
  policy: EnvoyLbPolicy,
  // zod v4's `.default` takes the parsed output type; run an empty object through
  // the schema so all CommonLbConfig sub-defaults are materialized.
  common: CommonLbConfig.default(() => CommonLbConfig.parse({})),
  queue: EnvoyQueueModel,
  locality: Locality.default({ region: 'r1', zone: 'z1' }),
});
export type EnvoyPool = z.infer<typeof EnvoyPool>;

// --- Backends (the single upstream service) ----------------------------------

export const BackendHealth = z.enum(['healthy', 'degraded', 'unhealthy', 'draining']);
export type BackendHealth = z.infer<typeof BackendHealth>;

/**
 * Per-backend fields, without pool-level defaults. {@link BackendSpec} adds the
 * defaults for the pool default; {@link BackendSpecOverride} stays default-free
 * so a sparse override only carries the fields the caller actually set.
 */
const backendFields = {
  /** Max concurrent requests the backend serves before queueing. */
  capacity: z.number().int().positive(),
  /** Service-time distribution (virtual ms) per request. */
  latency: Distribution,
  /** Pending queue depth; requests beyond capacity+queue are shed. */
  queueSize: z.number().int().nonnegative(),
  health: BackendHealth,
  /** LB weight (relative). */
  weight: z.number().int().positive(),
  locality: Locality,
} as const;

/** Per-backend behavior; used as the pool default (all fields defaulted). */
export const BackendSpec = z.object({
  ...backendFields,
  queueSize: z.number().int().nonnegative().default(0),
  health: BackendHealth.default('healthy'),
  weight: z.number().int().positive().default(1),
  locality: Locality.default({ region: 'r1', zone: 'z1' }),
});
export type BackendSpec = z.infer<typeof BackendSpec>;

/**
 * A sparse per-backend override. Only the fields explicitly set apply; absent
 * fields stay undefined (no defaults) so they fall through to the pool default
 * in {@link resolveBackend}. Using `BackendSpec.partial()` here would be wrong:
 * Zod still materializes each field's `.default()` when absent, clobbering the
 * pool default with the type default (e.g. queueSize -> 0).
 */
export const BackendSpecOverride = z.object(backendFields).partial();
export type BackendSpecOverride = z.infer<typeof BackendSpecOverride>;

export const BackendPool = z.object({
  count: z.number().int().positive(),
  defaults: BackendSpec,
  /** Sparse per-index overrides keyed by stringified backend index. */
  overrides: z.record(z.string(), BackendSpecOverride).default({}),
});
export type BackendPool = z.infer<typeof BackendPool>;

/**
 * Resolve backend `index`'s effective spec: the pool default with any sparse
 * override overlaid. The single source of truth for per-backend resolution, so
 * every consumer (kernel, views) reads overrides consistently.
 */
export function resolveBackend(pool: BackendPool, index: number): BackendSpec {
  const o = pool.overrides[String(index)];
  if (!o) return pool.defaults;
  const d = pool.defaults;
  return {
    capacity: o.capacity ?? d.capacity,
    latency: o.latency ?? d.latency,
    queueSize: o.queueSize ?? d.queueSize,
    health: o.health ?? d.health,
    weight: o.weight ?? d.weight,
    locality: o.locality ?? d.locality,
  };
}

// --- Network + timeouts ------------------------------------------------------

export const NetworkModel = z.object({
  clientToEnvoy: Distribution,
  envoyToBackend: Distribution,
  /** Extra one-way latency (ms) added when crossing zones. */
  crossZonePenaltyMs: z.number().nonnegative().default(0),
});
export type NetworkModel = z.infer<typeof NetworkModel>;

export const TimeoutConfig = z.object({
  /** End-to-end request timeout (virtual ms); exceeding it counts against goodput. */
  requestTimeoutMs: z.number().positive(),
  /** Optional per-try timeout for retries. */
  perTryTimeoutMs: z.number().positive().optional(),
  /** Number of retries on timeout/failure. */
  retries: z.number().int().nonnegative().default(0),
});
export type TimeoutConfig = z.infer<typeof TimeoutConfig>;
