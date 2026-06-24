import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'uplot/dist/uPlot.min.css';
import { App } from './App.tsx';
import './index.css';
import { useSimStore } from './store/sim-store';
import { createSimWorker } from './worker/client';

// Spin up the (currently synthetic) simulation worker, wire it into the store,
// and prepare the default run before first paint. Track B swaps the worker URL.
const { api } = createSimWorker();
useSimStore.getState().attach(api);
// Surface a boot load failure in the error modal rather than leaving an
// unhandled rejection (e.g. the worker aborts on the default config).
void useSimStore
  .getState()
  .load()
  .catch((err: unknown) => {
    useSimStore
      .getState()
      .raiseError(`Boot failed: ${err instanceof Error ? err.message : String(err)}`);
  });

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
