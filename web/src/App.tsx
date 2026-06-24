import { gaugeIndex } from '@elbsim/protocol';
import { Maximize2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ConfigEditor } from '@/components/config/ConfigEditor';
import { Dock } from '@/components/dock/Dock';
import { FleetHeatmap } from '@/components/fleet/FleetHeatmap';
import { DerivedStrip } from '@/components/timeline/DerivedStrip';
import type { DerivedLine } from '@/components/timeline/DerivedTimeline';
import { TimelineStrip } from '@/components/timeline/TimelineStrip';
import { TopologyModal } from '@/components/topology/TopologyModal';
import type { TopologySnapshot } from '@/components/topology/types';
import { TransportBar } from '@/components/transport/TransportBar';
import { goodputSeries, lossSeries, selectedSeries } from '@/lib/derive';
import type { Series } from '@/lib/series';
import { frameToTopologySnapshot } from '@/lib/topology-snapshot';
import { seriesColor } from '@/lib/uplot-opts';
import { useSimStore } from '@/store/sim-store';

/**
 * The cockpit shell. A high-SNR instrument panel: the playback transport pinned
 * to the top, a schema-driven config editor in the left rail, the dock (LB
 * inspector / window analysis) as a real right-hand column, and the hero in the
 * center -- a pinned fleet heatmap band over a vertically scrollable stack of
 * live timelines.
 *
 * The hot path stays off React: gauge strips read the shared ring buffers in a
 * 60fps rAF loop; only the low-rate heatmap snapshot (about 8Hz) and the
 * control state flow through the store. The earlier tabbed view switcher is
 * gone -- topology lives behind the heatmap's expand control (a modal), and the
 * analysis/inspector views live in the dock.
 */

// Per-entity gauge strips, fanned out one line per entity, grouped by tier.
// `rateScale: true` marks strips whose raw per-interval count must be
// converted to req/s by multiplying by `1000 / sampleIntervalMs` at render
// time (emitRate is sampled once per sim tick, so it is a per-interval count).
const GAUGE_STRIPS = [
  { kind: 'envoy' as const, gauge: 'inFlight', label: 'Envoy · in-flight', unit: 'reqs' },
  { kind: 'envoy' as const, gauge: 'queueDepth', label: 'Envoy · queue depth', unit: 'reqs' },
  {
    kind: 'backend' as const,
    gauge: 'utilization',
    label: 'Backend · utilization',
    unit: 'load 0-1',
  },
  { kind: 'backend' as const, gauge: 'inFlight', label: 'Backend · in-flight', unit: 'reqs' },
  {
    kind: 'backend' as const,
    gauge: 'latencyP99',
    label: 'Backend · latency p99',
    unit: 'ms',
  },
  {
    kind: 'client' as const,
    gauge: 'emitRate',
    label: 'Client · emit rate',
    unit: 'req/s',
    rateScale: true as const,
  },
  { kind: 'client' as const, gauge: 'inFlight', label: 'Client · in-flight', unit: 'reqs' },
];

// Pre-resolve the selected-envoy latency gauge columns (stable indices).
const ENVOY_P50 = gaugeIndex('envoy', 'latencyP50');
const ENVOY_P90 = gaugeIndex('envoy', 'latencyP90');
const ENVOY_P99 = gaugeIndex('envoy', 'latencyP99');

// Static line configs for the derived strips. These are MODULE-LEVEL constants
// (stable references) because DerivedTimeline's mount effect depends on `lines`:
// an inline array literal would be a fresh reference each App render, tearing
// down and recreating the uPlot instance on every play/pause/edit (a chart
// flash). Hoisting pins the reference so the effect only re-runs on a real
// remount trigger (the latency strip's `revision`, or `height`).
const LATENCY_LINES = [
  { label: 'p50', stroke: seriesColor(0) },
  { label: 'p90', stroke: seriesColor(3) },
  { label: 'p99', stroke: seriesColor(6) },
] satisfies DerivedLine[];

const GOODPUT_LINES = [{ label: 'goodput', stroke: seriesColor(5) }] satisfies DerivedLine[];

const LOSSES_LINES = [
  { label: 'timeouts', stroke: seriesColor(6) },
  { label: 'envoy rejects', stroke: seriesColor(3) },
  { label: 'backend shed', stroke: seriesColor(1) },
] satisfies DerivedLine[];

/** Recompute cadence for the heatmap snapshot: ~8Hz, off the 60fps hot path. */
const HEATMAP_TICK_MS = 125;

export function App(): React.JSX.Element {
  const policy = useSimStore((s) => s.config.envoys.policy.kind);
  const state = useSimStore((s) => s.status.state);
  const config = useSimStore((s) => s.config);
  const rings = useSimStore((s) => s.rings);
  const ready = useSimStore((s) => s.ready);
  const sampleIntervalMs = useSimStore((s) => s.config.time.sampleIntervalMs);
  const selectedEnvoy = useSimStore((s) => s.selectedEnvoy);
  const setSelectedEnvoy = useSimStore((s) => s.setSelectedEnvoy);

  const [topologyOpen, setTopologyOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<TopologySnapshot | null>(null);

  // Heatmap refresh: recompute the topology snapshot on a low-rate tick (the
  // rings advance in shared memory, not through React, so we sample them). An
  // immediate compute on mount/change avoids a blank band before the first tick;
  // the interval keeps it fresh while the sim runs. Both the heatmap and the
  // topology modal read this one snapshot.
  useEffect(() => {
    if (!ready || rings.size === 0) {
      setSnapshot(null);
      return;
    }
    const refresh = (): void => setSnapshot(frameToTopologySnapshot(config, rings));
    refresh();
    const id = setInterval(refresh, HEATMAP_TICK_MS);
    return () => clearInterval(id);
  }, [config, rings, ready]);

  // Builders for the derived strips. Each reads the shared rings directly inside
  // the rAF loop (see DerivedTimeline), so they never route 60fps frames through
  // React. The latency builder follows `selectedEnvoy` via a revision remount.
  const buildLatency = (): Series => {
    const ring = rings.get('envoy');
    if (!ring || selectedEnvoy === null) return { x: [], ys: [] };
    const p50 = selectedSeries(ring, ENVOY_P50, selectedEnvoy);
    const p90 = selectedSeries(ring, ENVOY_P90, selectedEnvoy);
    const p99 = selectedSeries(ring, ENVOY_P99, selectedEnvoy);
    return { x: p50.x, ys: [p50.y, p90.y, p99.y] };
  };
  const buildGoodput = (): Series => {
    const g = goodputSeries(rings, 0.3, sampleIntervalMs);
    return { x: g.x, ys: [g.y] };
  };
  const buildLosses = (): Series => {
    const l = lossSeries(rings, sampleIntervalMs);
    return { x: l.x, ys: [l.timeouts, l.envoyRejects, l.backendShed] };
  };

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <TransportBar />
      <header className="flex items-center justify-between border-b px-4 py-1.5">
        <h1 className="text-sm font-semibold tracking-tight">Envoy LB Simulator</h1>
        <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          {policy} · {state}
        </span>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="w-72 shrink-0 overflow-y-auto border-r p-3">
          <ConfigEditor />
        </aside>

        {/* Center hero: pinned heatmap band over the scrollable timeline stack. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="shrink-0 border-b p-3 pb-2">
            <div className="mb-1.5 flex items-center justify-between">
              <h2 className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Fleet load
              </h2>
              <button
                type="button"
                aria-label="Open topology graph"
                title="Expand the topology graph"
                onClick={() => setTopologyOpen(true)}
                className="flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Maximize2 size={11} />
                topology
              </button>
            </div>
            {snapshot ? (
              <FleetHeatmap
                snapshot={snapshot}
                selectedEnvoy={selectedEnvoy}
                onSelectEnvoy={setSelectedEnvoy}
              />
            ) : (
              <div className="flex h-20 items-center justify-center rounded-md border bg-card text-xs text-muted-foreground">
                Load a config to populate the fleet.
              </div>
            )}
          </div>

          <main className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {/* Envoy tier: gauges + the selected-envoy latency percentiles. */}
            {GAUGE_STRIPS.filter((s) => s.kind === 'envoy').map((s) => (
              <TimelineStrip
                key={`${s.kind}:${s.gauge}`}
                kind={s.kind}
                gauge={s.gauge}
                label={s.label}
                unit={s.unit}
                scale={'rateScale' in s ? 1000 / sampleIntervalMs : 1}
              />
            ))}
            <DerivedStrip
              label={
                selectedEnvoy === null
                  ? 'Envoy · latency (no envoy selected)'
                  : `Envoy · latency · e${selectedEnvoy}`
              }
              unit="ms"
              lines={LATENCY_LINES}
              build={buildLatency}
              revision={selectedEnvoy ?? -1}
            />

            {/* Backend tier. */}
            {GAUGE_STRIPS.filter((s) => s.kind === 'backend').map((s) => (
              <TimelineStrip
                key={`${s.kind}:${s.gauge}`}
                kind={s.kind}
                gauge={s.gauge}
                label={s.label}
                unit={s.unit}
                scale={'rateScale' in s ? 1000 / sampleIntervalMs : 1}
              />
            ))}

            {/* Client tier. */}
            {GAUGE_STRIPS.filter((s) => s.kind === 'client').map((s) => (
              <TimelineStrip
                key={`${s.kind}:${s.gauge}`}
                kind={s.kind}
                gauge={s.gauge}
                label={s.label}
                unit={s.unit}
                scale={'rateScale' in s ? 1000 / sampleIntervalMs : 1}
              />
            ))}

            {/* Fleet tier: derived goodput and per-stage losses. */}
            <DerivedStrip
              label="Fleet · goodput"
              unit="req/s"
              lines={GOODPUT_LINES}
              build={buildGoodput}
            />
            <DerivedStrip
              label="Fleet · losses by stage"
              unit="req/s"
              lines={LOSSES_LINES}
              build={buildLosses}
            />
          </main>
        </div>

        {/* Right column: the dock manages its own width and resize divider. */}
        <Dock />
      </div>

      <TopologyModal
        open={topologyOpen}
        snapshot={snapshot ?? { t: 0, clients: [], envoys: [], backends: [], edges: [] }}
        onClose={() => setTopologyOpen(false)}
        selectedEnvoy={selectedEnvoy}
        onSelectEnvoy={setSelectedEnvoy}
      />
    </div>
  );
}
