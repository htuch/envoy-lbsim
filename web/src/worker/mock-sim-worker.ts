import * as Comlink from 'comlink';
import { MockSimRunner } from './runner';

/**
 * Worker entry point. Exposes a {@link MockSimRunner} over Comlink as the
 * synthetic stand-in for the real simulation worker. Bootstrap glue only; the
 * runner logic lives in `runner.ts` and is unit-tested there.
 */
Comlink.expose(new MockSimRunner());
