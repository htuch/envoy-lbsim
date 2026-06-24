import type { SimConfig } from '@elbsim/config';
import { useMemo, useState } from 'react';
import { WindowAnalysis } from '@/components/analysis/WindowAnalysis';
import { TopologyGraph } from '@/components/topology/TopologyGraph';
import { Segmented } from '@/components/ui/segmented';
import { makeInspection, makeLatencyWindow, makeTopologySnapshot } from '@/synthetic';

/**
 * Track D demonstration harness. The real shell, config editor, playback
 * transport, and worker wiring belong to Track C; until they land this harness
 * drives the three Track D views (topology, cold-path analysis, LB inspector)
 * from the deterministic synthetic data in `@/synthetic`. Every view is
 * prop-driven so Track C can re-host it unchanged.
 */

type ViewId = 'topology' | 'analysis' | 'inspector';

const VIEWS = [
  { value: 'topology', label: 'Topology' },
  { value: 'analysis', label: 'Analysis' },
  { value: 'inspector', label: 'Inspector' },
] as const;

/** A fixed virtual instant the synthetic snapshots are taken at. */
const HARNESS_T = 1200;
/** A committed brushed window for the cold-path views. */
const HARNESS_WINDOW = { fromMs: 0, toMs: 5000 } as const;

export function Harness({ config }: { config: SimConfig }): React.JSX.Element {
  const [view, setView] = useState<ViewId>('topology');
  const [selectedEnvoy, setSelectedEnvoy] = useState(0);

  const snapshot = useMemo(() => makeTopologySnapshot(config, HARNESS_T), [config]);
  const window = useMemo(
    () => makeLatencyWindow(config, HARNESS_WINDOW.fromMs, HARNESS_WINDOW.toMs),
    [config],
  );
  const inspection = useMemo(
    () => makeInspection(config, selectedEnvoy, HARNESS_T),
    [config, selectedEnvoy],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <Segmented ariaLabel="View" options={VIEWS} value={view} onChange={setView} />
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          t = {HARNESS_T} ms
        </span>
      </div>
      <div className="min-h-0 flex-1">
        {view === 'topology' && (
          <TopologyGraph
            snapshot={snapshot}
            selectedEnvoy={selectedEnvoy}
            onSelectEnvoy={setSelectedEnvoy}
          />
        )}
        {view === 'analysis' && <WindowAnalysis window={window} />}
        {view === 'inspector' && (
          <Placeholder
            name="LB inspector"
            detail={`${inspection.structure.kind} · envoy e${selectedEnvoy}`}
          />
        )}
      </div>
    </div>
  );
}

/** Temporary panel placeholder; replaced by the real view in its own commit. */
function Placeholder({ name, detail }: { name: string; detail: string }): React.JSX.Element {
  return (
    <div className="grid h-full place-items-center">
      <div className="text-center">
        <p className="text-sm font-medium text-foreground">{name}</p>
        <p className="mt-1 font-mono text-xs tabular-nums text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}
