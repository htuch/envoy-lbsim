import type { EnvoyLbPolicyKind, SimConfig } from '@elbsim/config';
import { useMemo, useState } from 'react';
import { WindowAnalysis } from '@/components/analysis/WindowAnalysis';
import { LbInspector } from '@/components/inspector/LbInspector';
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

/**
 * Structure preview options: one policy per `LbStructure` kind, so the inspector
 * can render all four against a single scenario. A real deployment fixes the
 * policy in config; this selector is a harness affordance only.
 */
const PREVIEW_POLICIES = [
  { value: 'round_robin', label: 'EDF' },
  { value: 'maglev', label: 'Maglev' },
  { value: 'ring_hash', label: 'Ring' },
  { value: 'random', label: 'Random' },
] as const satisfies ReadonlyArray<{ value: EnvoyLbPolicyKind; label: string }>;

/** A fixed virtual instant the synthetic snapshots are taken at. */
const HARNESS_T = 1200;
/** A committed brushed window for the cold-path views. */
const HARNESS_WINDOW = { fromMs: 0, toMs: 5000 } as const;

export function Harness({ config }: { config: SimConfig }): React.JSX.Element {
  const [view, setView] = useState<ViewId>('topology');
  const [selectedEnvoy, setSelectedEnvoy] = useState(0);
  const [previewPolicy, setPreviewPolicy] = useState<EnvoyLbPolicyKind>('maglev');

  const snapshot = useMemo(() => makeTopologySnapshot(config, HARNESS_T), [config]);
  const window = useMemo(
    () => makeLatencyWindow(config, HARNESS_WINDOW.fromMs, HARNESS_WINDOW.toMs),
    [config],
  );
  const inspection = useMemo(
    () => makeInspection(config, selectedEnvoy, HARNESS_T, previewPolicy),
    [config, selectedEnvoy, previewPolicy],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2">
        <Segmented ariaLabel="View" options={VIEWS} value={view} onChange={setView} />
        {view === 'inspector' && (
          <Segmented
            ariaLabel="Structure preview"
            options={PREVIEW_POLICIES}
            value={previewPolicy}
            onChange={setPreviewPolicy}
          />
        )}
        <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
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
        {view === 'inspector' && <LbInspector inspection={inspection} />}
      </div>
    </div>
  );
}
