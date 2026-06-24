import type { SimWorkerApi } from '@elbsim/protocol';
import * as Comlink from 'comlink';

/**
 * Spawn the simulation worker and wrap it as a {@link SimWorkerApi} proxy.
 * Today it spins up the synthetic {@link './mock-sim-worker'}; when Track B's
 * kernel worker lands, only the worker URL here changes. Bootstrap glue,
 * excluded from coverage like `main.tsx`.
 */
export interface SimWorkerHandle {
  api: Comlink.Remote<SimWorkerApi>;
  dispose: () => void;
}

export function createSimWorker(): SimWorkerHandle {
  const worker = new Worker(new URL('./mock-sim-worker.ts', import.meta.url), {
    type: 'module',
    name: 'sim-mock',
  });
  return {
    api: Comlink.wrap<SimWorkerApi>(worker),
    dispose: () => worker.terminate(),
  };
}
