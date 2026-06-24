import type { WindowLatencySamples } from '@elbsim/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { WindowAnalysis } from '@/components/analysis/WindowAnalysis';
import { LbInspector } from '@/components/inspector/LbInspector';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/utils';
import { useSimStore } from '@/store/sim-store';

type DockTab = 'inspector' | 'window';

const TAB_OPTIONS = [
  { value: 'inspector' as const, label: 'Inspector' },
  { value: 'window' as const, label: 'Window' },
];

/** Minimum and maximum dock width in pixels (for the drag divider). */
const MIN_WIDTH = 280;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 380;

/**
 * Right-side dock column with two tabs: Inspector (LB state at the selected
 * Envoy) and Window (cold-path analysis of the brushed timeline window).
 *
 * Effect wiring:
 * - When `selection` becomes non-null, focuses the Window tab and calls
 *   `loadWindow(selection)`.
 * - When `selectedEnvoy` changes, OR when the sim pauses/steps/seeks
 *   (status.state transitions away from 'running' or virtualTimeMs changes
 *   while not running), focuses the Inspector tab and calls
 *   `loadInspection(selectedEnvoy, virtualTimeMs)`.
 *
 * Effects are gated on specific slice identities to prevent loops.
 */
export function Dock(): React.JSX.Element {
  // Initialize tab from the store so tests (and first-render) see the right
  // tab when the store is pre-seeded (e.g. a selection was already committed
  // before the dock mounts). Lazy initializer reads the store once at mount;
  // effects below handle subsequent changes.
  const [tab, setTab] = useState<DockTab>(() =>
    useSimStore.getState().selection !== null ? 'window' : 'inspector',
  );
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const dragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);
  // Tracks whether the component has mounted. Used to skip tab-focus on the
  // first render for effects that should only react to changes, not the initial
  // store state (the initial tab is already derived from the store in useState).
  const mounted = useRef(false);

  // --- store slices (subscribe to primitives, not objects) ---
  const selection = useSimStore((s) => s.selection);
  const selectedEnvoy = useSimStore((s) => s.selectedEnvoy);
  const statusState = useSimStore((s) => s.status.state);
  const virtualTimeMs = useSimStore((s) => s.status.virtualTimeMs);
  const inspection = useSimStore((s) => s.inspection);
  const inspectionLoading = useSimStore((s) => s.inspectionLoading);
  const windowAggregate = useSimStore((s) => s.windowAggregate);
  const windowSamples = useSimStore((s) => s.windowSamples);
  const windowLoading = useSimStore((s) => s.windowLoading);
  const fullRunSamples = useSimStore((s) => s.fullRunSamples);
  const ready = useSimStore((s) => s.ready);
  const loadWindow = useSimStore((s) => s.loadWindow);
  const loadInspection = useSimStore((s) => s.loadInspection);

  // --- Effect: committed selection => focus Window + fetch ---
  // On initial mount we skip the tab focus (initial tab already set from store)
  // but always call loadWindow if there is a selection (to populate the cache).
  useEffect(() => {
    if (selection === null) return;
    if (mounted.current) setTab('window');
    void loadWindow(selection);
  }, [selection, loadWindow]);

  // Keep refs in sync with the latest slices so effects can read the current
  // value without listing it as a dependency (which would mis-trigger the
  // effect). statusState/virtualTimeMs back the selectedEnvoy effect;
  // selectedEnvoy backs the pause/step/seek effect so a step/seek inspects the
  // currently-selected envoy without the effect re-firing on envoy changes.
  const statusStateRef = useRef(statusState);
  const virtualTimeMsRef = useRef(virtualTimeMs);
  const selectedEnvoyRef = useRef(selectedEnvoy);
  statusStateRef.current = statusState;
  virtualTimeMsRef.current = virtualTimeMs;
  selectedEnvoyRef.current = selectedEnvoy;

  // --- Effect: selectedEnvoy change => focus Inspector + fetch inspection.
  // Skip tab focus on the initial mount (initial tab already derived from the
  // store in useState). Also gate loadInspection on not running and on ready
  // (the worker's loadConfig must have completed before requestInspection can
  // be called; calling it before ready causes a "loadConfig has not been called"
  // error in the worker and logs an unhandled rejection in the browser console).
  // Uses statusStateRef/virtualTimeMsRef to read the current status without
  // adding them to the dep array (doing so would re-fire on every tick).
  useEffect(() => {
    if (mounted.current) setTab('inspector');
    if (!ready) return;
    if (statusStateRef.current === 'running') return;
    void loadInspection(selectedEnvoy, virtualTimeMsRef.current);
  }, [selectedEnvoy, loadInspection, ready]);

  // --- Effect: pause/step/seek => fetch inspection (gate: not running) ---
  // This effect owns ONLY the status/time transition path: it fires on
  // pause/step/seek (statusState or virtualTimeMs change). selectedEnvoy is
  // read via selectedEnvoyRef (not a dependency) so the envoy-change path stays
  // owned solely by the selectedEnvoy effect above; the two triggers are
  // disjoint, preventing a double loadInspection when both change together.
  useEffect(() => {
    if (statusState === 'running') return;
    // Fire on:
    // - transition from running to paused/finished
    // - virtualTimeMs change while already paused (e.g. step, seek)
    // Skip on initial mount -- the selectedEnvoy effect handles the first fetch.
    if (!mounted.current) return;
    void loadInspection(selectedEnvoyRef.current, virtualTimeMs);
  }, [statusState, virtualTimeMs, loadInspection]);

  // Mark as mounted after all initial effects have had a chance to run.
  // useEffect cleanup order guarantees this runs after the above effects on mount.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // --- Drag divider ---
  const onDividerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      dragStartX.current = e.clientX;
      dragStartWidth.current = width;

      const onMove = (me: MouseEvent): void => {
        if (!dragging.current) return;
        const delta = dragStartX.current - me.clientX;
        setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, dragStartWidth.current + delta)));
      };
      const onUp = (): void => {
        dragging.current = false;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [width],
  );

  return (
    <aside
      aria-label="LB inspector and window analysis"
      className="flex h-full shrink-0"
      style={{ width }}
    >
      {/* Drag divider -- <hr> is the semantic element for a vertical separator.
          tabIndex makes it keyboard-focusable as a splitter. */}
      <hr
        aria-label="Resize dock"
        aria-orientation="vertical"
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        className="m-0 w-1 cursor-col-resize border-none bg-border/40 transition-colors hover:bg-border active:bg-border/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onMouseDown={onDividerMouseDown}
      />

      {/* Dock content */}
      <div className="flex min-w-0 flex-1 flex-col border-l bg-card/30">
        {/* Tab bar */}
        <div className="flex shrink-0 items-center border-b px-2 py-1.5">
          <Segmented ariaLabel="Dock panel" options={TAB_OPTIONS} value={tab} onChange={setTab} />
        </div>

        {/* Panel content */}
        <div className="min-h-0 flex-1 overflow-hidden">
          {tab === 'inspector' ? (
            <InspectorPanel inspection={inspection} loading={inspectionLoading} />
          ) : (
            <WindowPanel
              aggregate={windowAggregate}
              samples={windowSamples}
              loading={windowLoading}
              hasSelection={selection !== null}
              {...(fullRunSamples !== null && { fullRunSamples })}
            />
          )}
        </div>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Sub-panels
// ---------------------------------------------------------------------------

interface InspectorPanelProps {
  inspection: ReturnType<typeof useSimStore.getState>['inspection'];
  loading: boolean;
}

function InspectorPanel({ inspection, loading }: InspectorPanelProps): React.JSX.Element {
  if (loading && !inspection) {
    return <LoadingState />;
  }
  if (!inspection) {
    return <EmptyState>Select an envoy in the topology to inspect its LB state.</EmptyState>;
  }
  return <LbInspector inspection={inspection} />;
}

interface WindowPanelProps {
  aggregate: ReturnType<typeof useSimStore.getState>['windowAggregate'];
  samples: ReturnType<typeof useSimStore.getState>['windowSamples'];
  loading: boolean;
  hasSelection: boolean;
  fullRunSamples?: WindowLatencySamples;
}

function WindowPanel({
  aggregate,
  samples,
  loading,
  hasSelection,
  fullRunSamples,
}: WindowPanelProps): React.JSX.Element {
  if (!hasSelection) {
    return <EmptyState>Brush a timeline to select a window for analysis.</EmptyState>;
  }
  if (loading && !aggregate) {
    return <LoadingState />;
  }
  if (!aggregate || !samples) {
    return <LoadingState />;
  }
  return (
    <WindowAnalysis
      aggregate={aggregate}
      samples={samples}
      {...(fullRunSamples !== undefined && { fullRunSamples })}
    />
  );
}

// ---------------------------------------------------------------------------
// Shared states
// ---------------------------------------------------------------------------

function LoadingState(): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center">
      <div
        role="status"
        aria-label="Loading"
        className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-foreground"
      />
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className={cn('flex h-full items-center justify-center p-6')}>
      <p className="max-w-[20ch] text-center text-xs text-muted-foreground">{children}</p>
    </div>
  );
}
