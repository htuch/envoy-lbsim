import { z } from 'zod';

/**
 * Load balancer policy configurations.
 *
 * The **Envoy** policies ({@link EnvoyLbPolicy}) mirror the field names and
 * defaults of Envoy's real proto config (see ARCHITECTURE.md and the Envoy
 * source under `third_party/envoy/`). They are the durable contract the Wasm LB
 * ABI consumes: `@elbsim/config` is the single source of truth, translated into
 * the flat C++ structs exposed via Embind. Keep field names aligned with Envoy.
 *
 * The **client** policies ({@link ClientLbPolicy}) are modeled in TypeScript in
 * the sim kernel (clients are not Envoy); they approximate how a client fleet
 * spreads traffic across Envoy replicas.
 */

// --- Shared Envoy sub-configs ------------------------------------------------

/** Envoy SlowStartConfig (common.proto). `windowMs: 0` disables slow start. */
export const SlowStartConfig = z.object({
  windowMs: z.number().nonnegative().default(0),
  aggression: z.number().positive().default(1),
  minWeightPercent: z.number().min(0).max(100).default(10),
});
export type SlowStartConfig = z.infer<typeof SlowStartConfig>;

/** Hash function selection for the consistent-hashing policies (ring_hash). */
export const HashFunction = z.enum(['xx_hash', 'murmur_hash_2']);
export type HashFunction = z.infer<typeof HashFunction>;

/** least_request selection method (Envoy least_request.proto). */
export const SelectionMethod = z.enum(['n_choices', 'full_scan']);
export type SelectionMethod = z.infer<typeof SelectionMethod>;

// --- Envoy LB policies -------------------------------------------------------

export const RoundRobinPolicy = z.object({
  kind: z.literal('round_robin'),
  slowStart: SlowStartConfig.optional(),
});

export const LeastRequestPolicy = z.object({
  kind: z.literal('least_request'),
  /** Number of random hosts compared (P2C). Envoy default 2, must be >= 2. */
  choiceCount: z.number().int().min(2).default(2),
  /** weight = lb_weight / (active_requests + 1)^bias. 0 == plain round robin. */
  activeRequestBias: z.number().nonnegative().default(1),
  selectionMethod: SelectionMethod.default('n_choices'),
  slowStart: SlowStartConfig.optional(),
});

export const RandomPolicy = z.object({
  kind: z.literal('random'),
});

export const RingHashPolicy = z.object({
  kind: z.literal('ring_hash'),
  minimumRingSize: z.number().int().min(1).max(8_388_608).default(1024),
  maximumRingSize: z.number().int().min(1).max(8_388_608).default(8_388_608),
  hashFunction: HashFunction.default('xx_hash'),
  useHostnameForHashing: z.boolean().default(false),
});

export const MaglevPolicy = z.object({
  kind: z.literal('maglev'),
  /** Lookup table size. Must be prime; Envoy default 65537, max 5000011. */
  tableSize: z.number().int().min(2).max(5_000_011).default(65537),
});

export const EnvoyLbPolicy = z.discriminatedUnion('kind', [
  RoundRobinPolicy,
  LeastRequestPolicy,
  RandomPolicy,
  RingHashPolicy,
  MaglevPolicy,
]);
export type EnvoyLbPolicy = z.infer<typeof EnvoyLbPolicy>;
export type EnvoyLbPolicyKind = EnvoyLbPolicy['kind'];

/** Locality handling: Envoy's two mutually-exclusive modes (CommonLbConfig oneof). */
export const LocalityLbMode = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('zone_aware'),
    routingEnabledPercent: z.number().min(0).max(100).default(100),
    minClusterSize: z.number().int().nonnegative().default(6),
    failTrafficOnPanic: z.boolean().default(false),
  }),
  z.object({ kind: z.literal('locality_weighted') }),
  z.object({ kind: z.literal('none') }),
]);
export type LocalityLbMode = z.infer<typeof LocalityLbMode>;

/** Envoy CommonLbConfig knobs shared across policies. */
export const CommonLbConfig = z.object({
  healthyPanicThresholdPercent: z.number().min(0).max(100).default(50),
  overprovisioningFactor: z.number().int().positive().default(140),
  locality: LocalityLbMode.default({ kind: 'none' }),
});
export type CommonLbConfig = z.infer<typeof CommonLbConfig>;

// --- Client-side LB (clients -> Envoy replicas) ------------------------------

export const ClientLbPolicy = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('round_robin') }),
  z.object({ kind: z.literal('random') }),
  /** Hash the request key onto the Envoy set (sticky routing). */
  z.object({ kind: z.literal('hash') }),
  /** Each client uses a random fixed subset of Envoys of the given size. */
  z.object({ kind: z.literal('subset'), subsetSize: z.number().int().positive() }),
  /**
   * Coarse DNS-style balancing: clients refresh a resolved Envoy set every
   * `refreshMs` and round-robin within it, modeling stale-resolution skew.
   */
  z.object({
    kind: z.literal('dns_approx'),
    refreshMs: z.number().positive(),
    resolvedSetSize: z.number().int().positive(),
  }),
]);
export type ClientLbPolicy = z.infer<typeof ClientLbPolicy>;
