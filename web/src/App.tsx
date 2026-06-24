import { defaultSimConfig, type SimConfig } from '@elbsim/config';
import { cn } from '@/lib/utils';

/**
 * Application shell. This is the scaffold the frontend tracks build on: it wires
 * the shared `@elbsim/config` source of truth into a high-SNR control-panel
 * layout (sidebar config + main visualization area). The simulation kernel,
 * worker wiring, and the uPlot / Observable Plot / React Flow views land in
 * later sessions per docs/STATUS.md.
 */
export function App(): React.JSX.Element {
  const config: SimConfig = defaultSimConfig();
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <h1 className="text-sm font-semibold tracking-tight">Envoy LB Simulator</h1>
        <span className="text-xs text-muted-foreground">scaffold</span>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="w-72 shrink-0 overflow-y-auto border-r p-3">
          <ConfigSummary config={config} />
        </aside>
        <main className="grid flex-1 place-items-center p-6">
          <p className="max-w-md text-center text-sm text-muted-foreground">
            Visualization surface. Topology graph, brushable timelines, and the LB data-structure
            inspector render here once the sim kernel and views are wired.
          </p>
        </main>
      </div>
    </div>
  );
}

function ConfigSummary({ config }: { config: SimConfig }): React.JSX.Element {
  const rows: Array<[string, string]> = [
    ['Clients', `${config.clients.count} · ${config.clients.arrival.kind}`],
    ['Envoys', `${config.envoys.count} · ${config.envoys.policy.kind}`],
    ['Backends', `${config.backends.count} · cap ${config.backends.defaults.capacity}`],
    ['Timeout', `${config.timeouts.requestTimeoutMs} ms`],
    ['Duration', `${config.time.durationMs} ms`],
    ['Seed', String(config.seed)],
  ];
  return (
    <dl className="space-y-1">
      <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Scenario
      </p>
      {rows.map(([label, value]) => (
        <div
          key={label}
          className={cn(
            'flex items-baseline justify-between gap-2 rounded px-2 py-1',
            'hover:bg-accent',
          )}
        >
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="font-mono text-xs tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
