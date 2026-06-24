import type { EnvoyLbPolicyKind } from '@elbsim/config';
import type { LbModule } from '@elbsim/protocol';
import { mockLbModule } from '@elbsim/sim-core';
import { loadLbModule } from '@elbsim/wasm-lb';
import type { SelectedLb } from './driver';

/**
 * Policies the real Wasm module supports (mirrors `createLb` in
 * `@elbsim/wasm-lb`'s `bindings/index.ts`). Single source of truth for REAL vs
 * MOCK selection; keep it in lockstep with the lift. Track A is complete, so all
 * five Envoy policies are lifted; this stays explicit so a future policy is not
 * silently assumed real before its Wasm support lands.
 */
export const LIFTED_POLICIES: ReadonlySet<EnvoyLbPolicyKind> = new Set<EnvoyLbPolicyKind>([
  'maglev',
  'ring_hash',
  'round_robin',
  'least_request',
  'random',
]);

export type LbMode = 'real' | 'mock';

/** Injectable loader so tests can supply a fake real module without emsdk. */
export interface SelectDeps {
  loadReal: () => Promise<LbModule | undefined>;
}

/* c8 ignore start */
const defaultDeps: SelectDeps = {
  async loadReal() {
    try {
      return await loadLbModule();
    } catch {
      return undefined; // artifact not built
    }
  },
};
/* c8 ignore end */

/**
 * Resolve which LB module to drive a policy with. `mock` forces the mock;
 * `real` requires real Wasm (errors if the policy is unlifted or unbuilt).
 */
export async function selectLb(
  policy: EnvoyLbPolicyKind,
  mode: LbMode,
  deps: SelectDeps = defaultDeps,
): Promise<SelectedLb> {
  if (mode === 'mock') return { module: mockLbModule, label: 'mock' };

  const lifted = LIFTED_POLICIES.has(policy);

  if (!lifted)
    throw new Error(
      `policy '${policy}' is not lifted to real Wasm yet; pass --mock to run it against the stub`,
    );
  const real = await deps.loadReal();
  if (!real) {
    throw new Error('real Wasm LB not built; run `pnpm run wasm:build`');
  }
  return { module: real, label: 'real' };
}
