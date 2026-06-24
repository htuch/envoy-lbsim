import type { SimWorkerApi } from '@elbsim/protocol';
import * as Comlink from 'comlink';

/**
 * Spawn the simulation worker and wrap it as a {@link SimWorkerApi} proxy.
 * Points at the real SimController worker backed by the composite LB module
 * (Wasm for maglev, mock for all other policies). Bootstrap glue,
 * excluded from coverage like `main.tsx`.
 */
export interface SimWorkerHandle {
  api: Comlink.Remote<SimWorkerApi>;
  dispose: () => void;
}

export function createSimWorker(): SimWorkerHandle {
  const worker = new Worker(new URL('./sim-worker.ts', import.meta.url), {
    type: 'module',
    name: 'sim',
  });
  return {
    api: Comlink.wrap<SimWorkerApi>(worker),
    dispose: () => worker.terminate(),
  };
}
