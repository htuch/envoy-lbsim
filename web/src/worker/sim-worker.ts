import { SimController } from '@elbsim/sim-core';
import { loadLbModule } from '@elbsim/wasm-lb';
import * as Comlink from 'comlink';

/* c8 ignore start -- Wasm-boundary entrypoint; requires a built artifact and a
   real Worker context, neither of which is available under jsdom/vitest. The
   SimController is tested in controller.test.ts. */

// Expose the controller eagerly -- before the Wasm loads -- so that Comlink
// messages sent by the main thread before loadLbModule() resolves are not
// dropped. Browsers running module workers queue messages sent before
// Comlink.expose() is called, but those queued messages are delivered only
// after the module's top-level await resolves and the event loop becomes free.
// If the main thread sends loadConfig before the worker calls Comlink.expose,
// the message is lost and the Promise never resolves.
//
// The fix: pass the lbModule as a Promise. SimController.loadConfig awaits it on
// the first call, so the real Envoy LB is used as soon as it is ready. All five
// policies are lifted to Wasm, so the real module handles every policy; the mock
// LB remains only as a sim-core test fixture.
Comlink.expose(new SimController({ lbModule: loadLbModule() }));

/* c8 ignore stop */
