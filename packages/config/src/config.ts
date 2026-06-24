import { z } from 'zod';
import { BackendPool, ClientPool, EnvoyPool, NetworkModel, TimeoutConfig } from './entities';

/**
 * The shared simulator configuration: the single in-memory source of truth that
 * every component (frontend editor, sim kernel, Wasm LB) reads. The frontend
 * manipulates a `SimConfig` and the kernel re-runs deterministically from it.
 */

/** Virtual-time settings. The kernel advances a virtual clock, not wall clock. */
export const VirtualTimeConfig = z.object({
  /** Total virtual duration to simulate (ms). */
  durationMs: z.number().positive(),
  /** Interval (virtual ms) at which per-entity gauge samples are emitted. */
  sampleIntervalMs: z.number().positive().default(10),
});
export type VirtualTimeConfig = z.infer<typeof VirtualTimeConfig>;

export const SCHEMA_VERSION = 1 as const;

export const SimConfig = z.object({
  /** Schema version; bump on breaking changes to enable migration. */
  version: z.literal(SCHEMA_VERSION),
  /** Seed for the deterministic PRNG shared by the kernel and the Wasm LB. */
  seed: z.number().int().nonnegative(),
  time: VirtualTimeConfig,
  clients: ClientPool,
  network: NetworkModel,
  envoys: EnvoyPool,
  backends: BackendPool,
  timeouts: TimeoutConfig,
});
export type SimConfig = z.infer<typeof SimConfig>;

/** Parse-and-validate untrusted input (e.g. an imported JSON config). */
export function parseSimConfig(input: unknown): SimConfig {
  return SimConfig.parse(input);
}

/** Non-throwing variant returning the Zod result. */
export function safeParseSimConfig(input: unknown) {
  return SimConfig.safeParse(input);
}
