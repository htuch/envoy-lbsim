import { ConfigEditor } from '@/components/config/ConfigEditor';
import { TimelineStrip } from '@/components/timeline/TimelineStrip';
import { TransportBar } from '@/components/transport/TransportBar';
import { useSimStore } from '@/store/sim-store';

/**
 * Application shell for Track C: a high-SNR control-panel layout. A schema-driven
 * config editor on the left, a stack of live gauge timelines in the center fed
 * from the shared ring buffers, and the playback transport pinned to the bottom.
 * The topology graph, cold-path analytical charts, and the LB inspector (Track D)
 * land in the visualization area in later sessions.
 */
const STRIPS = [
  { kind: 'envoy', gauge: 'inFlight', label: 'Envoy · in-flight' },
  { kind: 'envoy', gauge: 'queueDepth', label: 'Envoy · queue depth' },
  { kind: 'backend', gauge: 'utilization', label: 'Backend · utilization' },
  { kind: 'backend', gauge: 'inFlight', label: 'Backend · in-flight' },
  { kind: 'client', gauge: 'emitRate', label: 'Client · emit rate' },
] as const;

export function App(): React.JSX.Element {
  const policy = useSimStore((s) => s.config.envoys.policy.kind);
  const state = useSimStore((s) => s.status.state);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <h1 className="text-sm font-semibold tracking-tight">Envoy LB Simulator</h1>
        <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          {policy} · {state}
        </span>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="w-72 shrink-0 overflow-y-auto border-r p-3">
          <ConfigEditor />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <main className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {STRIPS.map((s) => (
              <TimelineStrip
                key={`${s.kind}:${s.gauge}`}
                kind={s.kind}
                gauge={s.gauge}
                label={s.label}
              />
            ))}
          </main>
          <TransportBar />
        </div>
      </div>
    </div>
  );
}
