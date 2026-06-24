import { useMemo, useState } from 'react';
import { WindowAnalysis } from '@/components/analysis/WindowAnalysis';
import { LbInspector } from '@/components/inspector/LbInspector';
import { TopologyGraph } from '@/components/topology/TopologyGraph';
import { useSimStore } from '@/store/sim-store';
import { makeInspection, makeLatencyWindow, makeTopologySnapshot } from '@/synthetic';

/**
 * Track C re-host of the Track D views (topology, cold-path analysis, LB
 * inspector) inside the real shell. Each view is the same prop-driven Track D
 * component; what changes here is the data source: instead of the standalone
 * harness's fixed scenario, the views are driven by the live store -- the edited
 * `config`, the current playback time (`status.virtualTimeMs`), the configured
 * policy, and the brushed `selection` window from the timelines.
 *
 * The view payloads are still computed by the deterministic `@/synthetic`
 * generators. Replacing those with the real worker telemetry (gauge frames ->
 * topology, `queryWindow` -> analysis, `requestInspection` -> inspection) is the
 * remaining Track C wiring tracked in docs/STATUS.md; the view components do not
 * change when that lands.
 */
export type AnalyticalViewId = 'topology' | 'analysis' | 'inspector';

export function AnalyticalViews({ view }: { view: AnalyticalViewId }): React.JSX.Element {
  const config = useSimStore((s) => s.config);
  const t = useSimStore((s) => s.status.virtualTimeMs);
  const selection = useSimStore((s) => s.selection);
  const policy = useSimStore((s) => s.config.envoys.policy.kind);

  // Shared between topology (click to select) and the inspector (renders it).
  const [selectedEnvoy, setSelectedEnvoy] = useState(0);
  const envoy = Math.min(selectedEnvoy, Math.max(0, config.envoys.count - 1));

  const snapshot = useMemo(() => makeTopologySnapshot(config, t), [config, t]);
  const window = useMemo(() => {
    // Follow the brushed window when one is committed; otherwise the run so far.
    const fromMs = selection?.fromMs ?? 0;
    const toMs = selection?.toMs ?? Math.max(t, 1);
    return makeLatencyWindow(config, fromMs, toMs);
  }, [config, selection, t]);
  const inspection = useMemo(
    () => makeInspection(config, envoy, t, policy),
    [config, envoy, t, policy],
  );

  switch (view) {
    case 'topology':
      return (
        <TopologyGraph snapshot={snapshot} selectedEnvoy={envoy} onSelectEnvoy={setSelectedEnvoy} />
      );
    case 'analysis':
      return <WindowAnalysis window={window} />;
    case 'inspector':
      return <LbInspector inspection={inspection} />;
  }
}
