import { useState } from 'react';
import { ConfigEditor } from '@/components/config/ConfigEditor';
import { TimelineStrip } from '@/components/timeline/TimelineStrip';
import { TransportBar } from '@/components/transport/TransportBar';
import { Segmented } from '@/components/ui/segmented';
import { type AnalyticalViewId, AnalyticalViews } from '@/components/views/AnalyticalViews';
import { useSimStore } from '@/store/sim-store';

/**
 * Application shell: a high-SNR control-panel layout. A schema-driven config
 * editor on the left, the playback transport pinned to the bottom, and a
 * switchable visualization surface in the center -- the live gauge timelines
 * (hot path, fed from the shared ring buffers) plus the Track D analytical views
 * (topology, cold-path analysis, LB inspector), all driven by the live store.
 */
const STRIPS = [
  { kind: 'envoy', gauge: 'inFlight', label: 'Envoy · in-flight' },
  { kind: 'envoy', gauge: 'queueDepth', label: 'Envoy · queue depth' },
  { kind: 'backend', gauge: 'utilization', label: 'Backend · utilization' },
  { kind: 'backend', gauge: 'inFlight', label: 'Backend · in-flight' },
  { kind: 'client', gauge: 'emitRate', label: 'Client · emit rate' },
] as const;

const VIEWS = [
  { value: 'timelines', label: 'Timelines' },
  { value: 'topology', label: 'Topology' },
  { value: 'analysis', label: 'Analysis' },
  { value: 'inspector', label: 'Inspector' },
] as const;
type ViewId = (typeof VIEWS)[number]['value'];

export function App(): React.JSX.Element {
  const policy = useSimStore((s) => s.config.envoys.policy.kind);
  const state = useSimStore((s) => s.status.state);
  const [view, setView] = useState<ViewId>('timelines');

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
          <div className="flex items-center gap-3 border-b px-3 py-2">
            <Segmented ariaLabel="Visualization" options={VIEWS} value={view} onChange={setView} />
          </div>
          {view === 'timelines' ? (
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
          ) : (
            <main className="min-h-0 flex-1 overflow-hidden">
              <AnalyticalViews view={view as AnalyticalViewId} />
            </main>
          )}
          <TransportBar />
        </div>
      </div>
    </div>
  );
}
