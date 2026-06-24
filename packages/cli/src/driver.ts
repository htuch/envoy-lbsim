import type { SimConfig } from '@elbsim/config';
import type { LbModule, RequestEvent } from '@elbsim/protocol';
import { SimEngine } from '@elbsim/sim-core';

/** Which LB implementation produced a run: real Envoy Wasm, or the TS mock. */
export type LbLabel = 'real' | 'mock';

/** A resolved LB choice (returned by selectLb in lb-select.ts). */
export interface SelectedLb {
  module: LbModule;
  label: LbLabel;
  note?: string;
}

export interface RunResult {
  events: readonly RequestEvent[];
  lbLabel: LbLabel;
}

/**
 * Drive one scenario to completion headless and return its cold-path event
 * stream. No SharedArrayBuffer rings or playback: a plain SimEngine run, which
 * is a pure function of `config.seed` and the LB module.
 */
export function runScenario(
  config: SimConfig,
  lb: { module: LbModule; label: LbLabel },
): RunResult {
  const engine = new SimEngine(config, { lbModule: lb.module });
  engine.runToCompletion();
  return { events: engine.events, lbLabel: lb.label };
}
