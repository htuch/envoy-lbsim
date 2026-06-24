import type { WindowAggregate, WindowLatencySamples, WindowQuery } from '@elbsim/protocol';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSimStore } from '@/store/sim-store';
import { MockSimRunner } from '@/worker/runner';
import { Dock } from './Dock';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/**
 * Observable Plot and uPlot are not available under jsdom. The WindowAnalysis
 * component uses them so we short-circuit here to test Dock behavior without
 * needing rendering infrastructure those libraries require.
 *
 * The mock also exposes fullRunSamples via a data attribute so tests can
 * assert the prop is threaded through from the store.
 */
vi.mock('@/components/analysis/WindowAnalysis', () => ({
  WindowAnalysis: ({
    aggregate,
    fullRunSamples,
  }: {
    aggregate: WindowAggregate;
    fullRunSamples?: WindowLatencySamples;
  }) => (
    <div
      data-testid="window-analysis"
      data-has-full-run={fullRunSamples !== undefined ? 'true' : 'false'}
    >
      {aggregate.totalRequests === 0 ? (
        <span>no requests in window</span>
      ) : (
        <span>window-analysis-rendered</span>
      )}
    </div>
  ),
}));

/**
 * LbInspector renders heavy sub-components. Replace with a thin stub so Dock
 * behavior tests can focus on store-driven tab focus and effect calls.
 */
vi.mock('@/components/inspector/LbInspector', () => ({
  LbInspector: () => <div data-testid="lb-inspector">lb-inspector-rendered</div>,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_AGGREGATE: WindowAggregate = {
  fromMs: 0,
  toMs: 5000,
  totalRequests: 100,
  completed: 80,
  timedOut: 15,
  rejected: 5,
  goodput: 0.8,
  latencyP50: 12.3,
  latencyP90: 34.5,
  latencyP99: 56.7,
};

const BASE_SAMPLES: WindowLatencySamples = {
  fromMs: 0,
  toMs: 5000,
  latencies: [5, 10, 12, 15, 20, 25],
  capped: false,
};

const SELECTION: WindowQuery = { fromMs: 0, toMs: 5000 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let loadWindowSpy: ReturnType<typeof vi.fn>;
let loadInspectionSpy: ReturnType<typeof vi.fn>;

/**
 * Reset the store and attach a fresh mock runner, then immediately replace the
 * two async store actions with spies so Dock's useEffect wiring does not hit
 * the real MockSimRunner (which throws for inspection).
 */
async function setupStore(): Promise<void> {
  useSimStore.setState(useSimStore.getInitialState(), true);
  useSimStore.getState().attach(new MockSimRunner());
  await useSimStore.getState().load();
  // Replace actions AFTER load() so the initial load() itself can run, but
  // before any component mount triggers the effects.
  loadWindowSpy = vi.fn().mockResolvedValue(undefined);
  loadInspectionSpy = vi.fn().mockResolvedValue(undefined);
  useSimStore.setState({
    loadWindow: loadWindowSpy as unknown as (q: WindowQuery) => Promise<void>,
    loadInspection: loadInspectionSpy as unknown as (envoy: number, tMs: number) => Promise<void>,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Dock', () => {
  beforeEach(async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    await setupStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useSimStore.setState(useSimStore.getInitialState(), true);
  });

  // ---- tab rendering -------------------------------------------------------

  it('renders Inspector and Window tab buttons', () => {
    render(<Dock />);
    expect(screen.getByRole('radio', { name: 'Inspector' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Window' })).toBeInTheDocument();
  });

  it('defaults to Inspector tab when no selection and no inspected envoy', () => {
    render(<Dock />);
    expect(screen.getByRole('radio', { name: 'Inspector' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: 'Window' })).toHaveAttribute('aria-checked', 'false');
  });

  it('shows a hint when no envoy has been inspected yet on Inspector tab', () => {
    // No inspection in store and no inspectionLoading.
    useSimStore.setState({ inspection: null, inspectionLoading: false });
    render(<Dock />);
    expect(screen.getByText(/select an envoy/i)).toBeInTheDocument();
  });

  it('shows the empty hint when no envoy is selected, even with a stale inspection', () => {
    const inspection = {
      envoy: 0,
      t: 0,
      policy: 'maglev' as const,
      panic: false,
      hosts: [],
      structure: { kind: 'none' as const },
    };
    useSimStore.setState({ selectedEnvoy: null, inspection, inspectionLoading: false });
    render(<Dock />);
    expect(screen.getByText(/select an envoy/i)).toBeInTheDocument();
    expect(screen.queryByTestId('lb-inspector')).not.toBeInTheDocument();
  });

  it('does not call loadInspection when selectedEnvoy is null', () => {
    useSimStore.setState({
      status: { state: 'paused', virtualTimeMs: 1000, speed: 1 },
      selectedEnvoy: 0,
    });
    render(<Dock />);
    loadInspectionSpy.mockClear();
    act(() => {
      useSimStore.setState({ selectedEnvoy: null });
    });
    expect(loadInspectionSpy).not.toHaveBeenCalled();
  });

  it('shows a loading spinner while inspectionLoading and no inspection', () => {
    useSimStore.setState({ inspection: null, inspectionLoading: true });
    render(<Dock />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders LbInspector once inspection is available', () => {
    const inspection = {
      envoy: 0,
      t: 0,
      policy: 'maglev' as const,
      panic: false,
      hosts: [],
      structure: { kind: 'none' as const },
    };
    useSimStore.setState({ inspection, inspectionLoading: false });
    render(<Dock />);
    expect(screen.getByTestId('lb-inspector')).toBeInTheDocument();
  });

  // ---- Window tab focus on selection commit --------------------------------

  it('focuses Window tab when a new selection is committed', async () => {
    render(<Dock />);
    // Simulate a selection being committed.
    act(() => {
      useSimStore.setState({ selection: SELECTION });
    });
    expect(screen.getByRole('radio', { name: 'Window' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Inspector' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('calls loadWindow when selection is committed', () => {
    render(<Dock />);
    act(() => {
      useSimStore.setState({ selection: SELECTION });
    });
    expect(loadWindowSpy).toHaveBeenCalledWith(SELECTION);
  });

  it('does not call loadWindow when selection is cleared (set to null)', () => {
    // Start with a selection already in place.
    useSimStore.setState({ selection: SELECTION });
    render(<Dock />);
    loadWindowSpy.mockClear();
    act(() => {
      useSimStore.setState({ selection: null });
    });
    expect(loadWindowSpy).not.toHaveBeenCalled();
  });

  // ---- Window tab empty/loading states ------------------------------------

  it('shows "brush a timeline" hint on Window tab when selection is null', () => {
    useSimStore.setState({ selection: null });
    render(<Dock />);
    // Switch to Window tab.
    act(() => {
      screen.getByRole('radio', { name: 'Window' }).click();
    });
    expect(screen.getByText(/brush a timeline/i)).toBeInTheDocument();
  });

  it('shows a loading spinner while windowLoading and no aggregate', () => {
    useSimStore.setState({ selection: SELECTION, windowLoading: true, windowAggregate: null });
    render(<Dock />);
    // Window tab is focused automatically by the selection in store.
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders WindowAnalysis with the stored aggregate and samples', () => {
    useSimStore.setState({
      selection: SELECTION,
      windowAggregate: BASE_AGGREGATE,
      windowSamples: BASE_SAMPLES,
      windowLoading: false,
    });
    render(<Dock />);
    expect(screen.getByTestId('window-analysis')).toBeInTheDocument();
  });

  it('passes fullRunSamples to WindowAnalysis when the store has it', () => {
    const fullRunSamples: WindowLatencySamples = {
      fromMs: 0,
      toMs: 10000,
      latencies: [1, 2, 3, 4, 5],
      capped: false,
    };
    useSimStore.setState({
      selection: SELECTION,
      windowAggregate: BASE_AGGREGATE,
      windowSamples: BASE_SAMPLES,
      windowLoading: false,
      fullRunSamples,
    });
    render(<Dock />);
    expect(screen.getByTestId('window-analysis')).toHaveAttribute('data-has-full-run', 'true');
  });

  it('does not pass fullRunSamples to WindowAnalysis when the store has null', () => {
    useSimStore.setState({
      selection: SELECTION,
      windowAggregate: BASE_AGGREGATE,
      windowSamples: BASE_SAMPLES,
      windowLoading: false,
      fullRunSamples: null,
    });
    render(<Dock />);
    expect(screen.getByTestId('window-analysis')).toHaveAttribute('data-has-full-run', 'false');
  });

  it('shows "no requests in window" when aggregate has totalRequests === 0', () => {
    const emptyAgg: WindowAggregate = {
      ...BASE_AGGREGATE,
      totalRequests: 0,
      completed: 0,
      timedOut: 0,
      rejected: 0,
    };
    useSimStore.setState({
      selection: SELECTION,
      windowAggregate: emptyAgg,
      windowSamples: BASE_SAMPLES,
      windowLoading: false,
    });
    render(<Dock />);
    expect(screen.getByText(/no requests in window/i)).toBeInTheDocument();
  });

  // ---- Inspector focus and loadInspection on selectedEnvoy change ---------

  it('focuses Inspector tab when selectedEnvoy changes', () => {
    // Start with Window tab active via a selection.
    useSimStore.setState({ selection: SELECTION });
    render(<Dock />);
    // Window tab must be active (the initial selection effect fires synchronously
    // via the initial store state, before render sees the effect trigger).
    // Force it via act.
    act(() => {
      useSimStore.setState({ selection: SELECTION });
    });
    expect(screen.getByRole('radio', { name: 'Window' })).toHaveAttribute('aria-checked', 'true');

    // Change the selected envoy.
    act(() => {
      useSimStore.setState({ selectedEnvoy: 1 });
    });
    expect(screen.getByRole('radio', { name: 'Inspector' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('calls loadInspection exactly once when selectedEnvoy changes while paused', () => {
    useSimStore.setState({
      status: { state: 'paused', virtualTimeMs: 1000, speed: 1 },
      selectedEnvoy: 0,
    });
    render(<Dock />);
    loadInspectionSpy.mockClear();
    act(() => {
      useSimStore.setState({ selectedEnvoy: 2 });
    });
    // The envoy-change path is owned solely by the selectedEnvoy effect; the
    // pause/step/seek effect must NOT also fire (it excludes selectedEnvoy from
    // its deps). A double call here would mean duplicated cold-path work.
    expect(loadInspectionSpy).toHaveBeenCalledTimes(1);
    expect(loadInspectionSpy).toHaveBeenCalledWith(2, 1000);
  });

  it('does not call loadInspection while the sim is running', () => {
    useSimStore.setState({ status: { state: 'running', virtualTimeMs: 500, speed: 1 } });
    render(<Dock />);
    loadInspectionSpy.mockClear();
    act(() => {
      // Changing time while running should not trigger inspection.
      useSimStore.setState({ status: { state: 'running', virtualTimeMs: 600, speed: 1 } });
    });
    expect(loadInspectionSpy).not.toHaveBeenCalled();
  });

  it('does not call loadInspection before the worker is ready', () => {
    // Guard: calling requestInspection before loadConfig has run throws in the
    // worker. The Dock must not call loadInspection while ready is false.
    useSimStore.setState({ ready: false, selectedEnvoy: 0 });
    render(<Dock />);
    expect(loadInspectionSpy).not.toHaveBeenCalled();
  });

  it('calls loadInspection when state transitions to paused', () => {
    useSimStore.setState({
      status: { state: 'running', virtualTimeMs: 500, speed: 1 },
      selectedEnvoy: 1,
    });
    render(<Dock />);
    loadInspectionSpy.mockClear();
    act(() => {
      useSimStore.setState({ status: { state: 'paused', virtualTimeMs: 500, speed: 1 } });
    });
    expect(loadInspectionSpy).toHaveBeenCalledWith(1, 500);
  });

  it('allows manual tab switching by the user', async () => {
    const user = userEvent.setup();
    useSimStore.setState({ selection: SELECTION });
    render(<Dock />);
    // Force Window active via act.
    act(() => {
      useSimStore.setState({ selection: SELECTION });
    });
    expect(screen.getByRole('radio', { name: 'Window' })).toHaveAttribute('aria-checked', 'true');
    // User clicks Inspector tab.
    await user.click(screen.getByRole('radio', { name: 'Inspector' }));
    expect(screen.getByRole('radio', { name: 'Inspector' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  // ---- drag divider -------------------------------------------------------

  it('exposes a drag divider with the separator role', () => {
    render(<Dock />);
    expect(screen.getByRole('separator', { name: 'Resize dock' })).toBeInTheDocument();
  });

  it('resizes the dock by dragging the divider', () => {
    const { container } = render(<Dock />);
    const dock = container.firstChild as HTMLElement;
    // Initial width.
    const initial = Number.parseInt(dock.style.width, 10);

    const divider = screen.getByRole('separator', { name: 'Resize dock' });

    // Simulate mousedown on the divider at x=500, then mousemove leftward (x=400)
    // to widen the dock, then mouseup to release.
    fireEvent.mouseDown(divider, { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 400 });
    fireEvent.mouseUp(window);

    const after = Number.parseInt(dock.style.width, 10);
    // Moving 100px left should increase width by 100px.
    expect(after).toBe(initial + 100);
  });
});
