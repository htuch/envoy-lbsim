import type { CommonLbConfig, EnvoyLbPolicy } from '@elbsim/config';
import type { LbInstance, LbModule } from '@elbsim/protocol';

/**
 * Routes `maglev` policy requests to the real Wasm-backed LB module and all
 * other policies to the mock. This lets the real Envoy C++ handle the policies
 * it has implemented while the mock covers the rest during development.
 */
export function makeCompositeLbModule(real: LbModule, mock: LbModule): LbModule {
  return {
    createLb(policy: EnvoyLbPolicy, common: CommonLbConfig, seed: number): LbInstance {
      return policy.kind === 'maglev'
        ? real.createLb(policy, common, seed)
        : mock.createLb(policy, common, seed);
    },
  };
}
