import type { EnvoyLbPolicyKind } from '@elbsim/config';
import type { LbModule } from '@elbsim/protocol';
import { mockLbModule } from '@elbsim/sim-core';
import { loadLbModule } from '@elbsim/wasm-lb';
import type { SelectedLb } from './driver';

/**
 * Policies the real Wasm module currently supports. Single source of truth for
 * REAL vs MOCK selection; expand in lockstep with Track A (ring_hash, then the
 * EDF policies). Flips real-only validation checks from SKIP to live.
 */
export const LIFTED_POLICIES: ReadonlySet<EnvoyLbPolicyKind> = new Set<EnvoyLbPolicyKind>([
  'maglev',
]);

export type LbMode = 'auto' | 'mock' | 'real';

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
 * `real` requires real Wasm (errors if the policy is unlifted or unbuilt);
 * `auto` prefers real for lifted policies and otherwise falls back to the mock
 * with an explanatory note.
 */
export async function selectLb(
  policy: EnvoyLbPolicyKind,
  mode: LbMode,
  deps: SelectDeps = defaultDeps,
): Promise<SelectedLb> {
  if (mode === 'mock') return { module: mockLbModule, label: 'mock' };

  const lifted = LIFTED_POLICIES.has(policy);

  if (mode === 'real') {
    if (!lifted) throw new Error(`policy '${policy}' is not lifted to real Wasm yet`);
    const real = await deps.loadReal();
    if (!real) {
      throw new Error('wasm-lb artifact not built; run `pnpm --filter @elbsim/wasm-lb build`');
    }
    return { module: real, label: 'real' };
  }

  // auto
  if (!lifted) {
    return {
      module: mockLbModule,
      label: 'mock',
      note: `policy '${policy}' not lifted; using mock LB`,
    };
  }
  const real = await deps.loadReal();
  if (!real) {
    return {
      module: mockLbModule,
      label: 'mock',
      note: 'wasm-lb artifact not built; using mock LB',
    };
  }
  return { module: real, label: 'real' };
}
