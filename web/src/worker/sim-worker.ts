import { mockLbModule, SimController } from '@elbsim/sim-core';
import { loadLbModule } from '@elbsim/wasm-lb';
import * as Comlink from 'comlink';
import { makeCompositeLbModule } from './composite-lb';

/* c8 ignore start -- Wasm-boundary entrypoint; requires a built artifact and a
   real Worker context, neither of which is available under jsdom/vitest. The
   composite routing logic is unit-tested in composite-lb.test.ts; the
   SimController is tested in controller.test.ts. */

// Expose the controller eagerly -- before the Wasm loads -- so that Comlink
// messages sent by the main thread before loadLbModule() resolves are not
// dropped. Browsers running module workers queue messages sent before
// Comlink.expose() is called, but those queued messages are delivered only
// after the module's top-level await resolves and the event loop becomes free.
// If the main thread sends loadConfig before the worker calls Comlink.expose,
// the message is lost and the Promise never resolves.
//
// The fix: pass the lbModule as a Promise. SimController.loadConfig awaits it
// on the first call, so the real Maglev module is used as soon as it is ready.
const lbModulePromise = loadLbModule().then((real) => makeCompositeLbModule(real, mockLbModule));

Comlink.expose(new SimController({ lbModule: lbModulePromise }));

/* c8 ignore stop */
