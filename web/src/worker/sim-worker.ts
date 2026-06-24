import { mockLbModule, SimController } from '@elbsim/sim-core';
import { loadLbModule } from '@elbsim/wasm-lb';
import * as Comlink from 'comlink';
import { makeCompositeLbModule } from './composite-lb';

/* c8 ignore start -- Wasm-boundary entrypoint; requires a built artifact and a
   real Worker context, neither of which is available under jsdom/vitest. The
   composite routing logic is unit-tested in composite-lb.test.ts; the
   SimController is tested in controller.test.ts. */

const real = await loadLbModule();
const lbModule = makeCompositeLbModule(real, mockLbModule);
Comlink.expose(new SimController({ lbModule }));

/* c8 ignore stop */
