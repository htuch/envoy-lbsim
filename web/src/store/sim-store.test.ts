import { defaultSimConfig } from '@elbsim/config';
import type {
  LbInspection,
  WindowAggregate,
  WindowLatencySamples,
  WindowQuery,
} from '@elbsim/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockSimRunner } from '@/worker/runner';
import { useSimStore } from './sim-store';

function reset(): void {
  useSimStore.setState(useSimStore.getInitialState(), true);
}

/** Minimal stub window aggregate. */
const FAKE_AGGREGATE: WindowAggregate = {
  fromMs: 0,
  toMs: 1000,
  totalRequests: 100,
  completed: 95,
  timedOut: 3,
  rejected: 2,
  goodput: 0.95,
  latencyP50: 10,
  latencyP90: 30,
  latencyP99: 80,
};

/** Minimal stub window latency samples. */
const FAKE_SAMPLES: WindowLatencySamples = {
  fromMs: 0,
  toMs: 1000,
  latencies: [5, 10, 20],
  capped: false,
};

/** Distinct full-run latency samples (fromMs=0, toMs=durationMs). */
const FAKE_FULL_RUN_SAMPLES: WindowLatencySamples = {
  fromMs: 0,
  toMs: 10000,
  latencies: [1, 2, 3, 4, 5],
  capped: false,
};

/** Minimal stub LbInspection. */
const FAKE_INSPECTION: LbInspection = {
  envoy: 0,
  t: 500,
  policy: 'round_robin',
  panic: false,
  hosts: [],
  structure: { kind: 'none' },
};

/**
 * A fake SimWorkerApi that supports manual promise resolution for testing
 * async stale-drop logic. Implements only the methods needed by the new store
 * additions; loadConfig/status use real MockSimRunner.
 *
 * queryWindow (aggregate) and queryWindowLatencies (samples) use separate
 * queues so tests can resolve them independently. On the first loadWindow
 * call, the store calls queryWindowLatencies twice (once for the window query,
 * once for the full-run baseline), so latency resolvers must be drained in
 * order.
 */
class FakeApi extends MockSimRunner {
  private _aggResolvers: Array<(v: WindowAggregate) => void> = [];
  private _samplesResolvers: Array<(v: WindowLatencySamples) => void> = [];
  private _inspectionResolvers: Array<(v: LbInspection) => void> = [];

  pendingAggCount(): number {
    return this._aggResolvers.length;
  }

  pendingSamplesCount(): number {
    return this._samplesResolvers.length;
  }

  pendingInspectionCount(): number {
    return this._inspectionResolvers.length;
  }

  override queryWindow(_q: WindowQuery): Promise<WindowAggregate> {
    return new Promise((res) => {
      this._aggResolvers.push(res);
    });
  }

  override queryWindowLatencies(_q: WindowQuery): Promise<WindowLatencySamples> {
    return new Promise((res) => {
      this._samplesResolvers.push(res);
    });
  }

  /**
   * Resolve the oldest pending queryWindow aggregate and ONE pending
   * queryWindowLatencies promise (for the window samples). On the first
   * loadWindow call there will be two pending latency resolvers (window +
   * full-run); use resolveNextFullRun to drain the second one.
   */
  resolveNextWindow(
    agg: WindowAggregate = FAKE_AGGREGATE,
    samples: WindowLatencySamples = FAKE_SAMPLES,
  ): void {
    this._aggResolvers.shift()?.(agg);
    this._samplesResolvers.shift()?.(samples);
  }

  /**
   * Resolve the next pending queryWindowLatencies promise with a full-run
   * sample set. Call this after resolveNextWindow on the first loadWindow to
   * drain the full-run query that the store issues in parallel.
   */
  resolveNextFullRun(samples: WindowLatencySamples = FAKE_FULL_RUN_SAMPLES): void {
    this._samplesResolvers.shift()?.(samples);
  }

  override requestInspection(_envoy: number, _tMs: number): Promise<LbInspection> {
    return new Promise((res) => {
      this._inspectionResolvers.push(res);
    });
  }

  /** Resolve the oldest pending requestInspection call. */
  resolveNextInspection(insp: LbInspection = FAKE_INSPECTION): void {
    const r = this._inspectionResolvers.shift();
    r?.(insp);
  }
}

describe('useSimStore', () => {
  beforeEach(reset);
  afterEach(() => {
    const { api } = useSimStore.getState();
    if (api && 'dispose' in api) (api as MockSimRunner).dispose();
    reset();
  });

  it('starts idle and unattached', () => {
    const s = useSimStore.getState();
    expect(s.api).toBeNull();
    expect(s.ready).toBe(false);
    expect(s.status.state).toBe('idle');
  });

  it('load without an attached worker throws', async () => {
    await expect(useSimStore.getState().load()).rejects.toThrow(/not attached/);
  });

  it('transport actions and sync are no-ops while unattached', async () => {
    const store = useSimStore.getState();
    await store.play();
    await store.pause();
    await store.step();
    await store.seek(0);
    await store.setSpeed(2);
    await store.syncStatus();
    expect(useSimStore.getState().status.state).toBe('idle');
  });

  it('attaches a worker, loads, and builds a ring per entity kind', async () => {
    useSimStore.getState().attach(new MockSimRunner());
    await useSimStore.getState().load();
    const s = useSimStore.getState();
    expect(s.ready).toBe(true);
    expect([...s.rings.keys()].sort()).toEqual(['backend', 'client', 'envoy']);
    expect(s.rings.get('envoy')?.size()).toBe(1);
    expect(s.status.state).toBe('paused');
  });

  it('proxies transport controls to the worker and mirrors status', async () => {
    useSimStore.getState().attach(new MockSimRunner());
    await useSimStore.getState().load({
      ...defaultSimConfig(),
      time: { durationMs: 100, sampleIntervalMs: 10 },
    });
    await useSimStore.getState().step();
    expect(useSimStore.getState().status.virtualTimeMs).toBe(10);
    await useSimStore.getState().seek(50);
    expect(useSimStore.getState().status.virtualTimeMs).toBe(50);
    await useSimStore.getState().setSpeed(2);
    await useSimStore.getState().play();
    expect(useSimStore.getState().status.state).toBe('running');
    await useSimStore.getState().pause();
    expect(useSimStore.getState().status.state).toBe('paused');
  });

  it('setConfig replaces the draft without reloading', () => {
    const next = { ...defaultSimConfig(), seed: 42 };
    useSimStore.getState().setConfig(next);
    expect(useSimStore.getState().config.seed).toBe(42);
    expect(useSimStore.getState().ready).toBe(false);
  });

  it('holds and clears the shared brushed selection', () => {
    expect(useSimStore.getState().selection).toBeNull();
    useSimStore.getState().setSelection({ fromMs: 1000, toMs: 2000 });
    expect(useSimStore.getState().selection).toEqual({ fromMs: 1000, toMs: 2000 });
    useSimStore.getState().setSelection(null);
    expect(useSimStore.getState().selection).toBeNull();
  });

  it('clears any selection when a fresh run is loaded', async () => {
    useSimStore.getState().attach(new MockSimRunner());
    useSimStore.getState().setSelection({ fromMs: 1000, toMs: 2000 });
    await useSimStore.getState().load();
    expect(useSimStore.getState().selection).toBeNull();
  });

  // ---- selectedEnvoy --------------------------------------------------------

  it('selectedEnvoy initialises to 0', () => {
    expect(useSimStore.getState().selectedEnvoy).toBe(0);
  });

  it('setSelectedEnvoy updates selectedEnvoy', () => {
    useSimStore.getState().setSelectedEnvoy(3);
    expect(useSimStore.getState().selectedEnvoy).toBe(3);
  });

  // ---- handle / cache clearing ----------------------------------------------

  it('handle initialises to 0 and load() bumps it each call', async () => {
    const api = new FakeApi();
    useSimStore.getState().attach(api);
    expect(useSimStore.getState().handle).toBe(0);
    await useSimStore.getState().load();
    expect(useSimStore.getState().handle).toBe(1);
    await useSimStore.getState().load();
    expect(useSimStore.getState().handle).toBe(2);
  });

  it('load() clears window and inspection caches', async () => {
    const api = new FakeApi();
    useSimStore.getState().attach(api);
    await useSimStore.getState().load();

    // Seed some cache state manually so we can verify it is cleared.
    useSimStore.setState({
      windowAggregate: FAKE_AGGREGATE,
      windowSamples: FAKE_SAMPLES,
      fullRunSamples: FAKE_FULL_RUN_SAMPLES,
    });

    await useSimStore.getState().load();
    const s = useSimStore.getState();
    expect(s.windowAggregate).toBeNull();
    expect(s.windowSamples).toBeNull();
    expect(s.fullRunSamples).toBeNull();
    expect(s.inspection).toBeNull();
  });

  // ---- loadWindow -----------------------------------------------------------

  it('loadWindow populates windowAggregate and windowSamples and toggles windowLoading', async () => {
    const api = new FakeApi();
    useSimStore.getState().attach(api);
    await useSimStore.getState().load();

    // Kick off loadWindow (does not await yet).
    const q: WindowQuery = { fromMs: 0, toMs: 1000 };
    const loading = useSimStore.getState().loadWindow(q);

    // While in-flight, windowLoading should be true.
    expect(useSimStore.getState().windowLoading).toBe(true);

    // Resolve the window query (agg + window samples) and the full-run
    // baseline (second queryWindowLatencies call on the first loadWindow).
    api.resolveNextWindow();
    api.resolveNextFullRun();

    await loading;

    const s = useSimStore.getState();
    expect(s.windowLoading).toBe(false);
    expect(s.windowAggregate).toEqual(FAKE_AGGREGATE);
    expect(s.windowSamples).toEqual(FAKE_SAMPLES);
  });

  it('stale loadWindow (handle changed mid-flight) does not overwrite newer state', async () => {
    const api = new FakeApi();
    useSimStore.getState().attach(api);
    await useSimStore.getState().load();

    const q: WindowQuery = { fromMs: 0, toMs: 1000 };

    // Start a loadWindow.
    const staleLoad = useSimStore.getState().loadWindow(q);

    // Simulate a reload while the window query is in-flight; this bumps handle.
    await useSimStore.getState().load();
    // Seed fresh window data from the new run.
    const freshAggregate: WindowAggregate = { ...FAKE_AGGREGATE, totalRequests: 999 };
    useSimStore.setState({ windowAggregate: freshAggregate });

    // Resolve all three in-flight promises for the stale loadWindow call
    // (aggregate + window samples + full-run samples) so Promise.all settles.
    api.resolveNextWindow();
    api.resolveNextFullRun();
    await staleLoad;

    // The stale result must NOT have overwritten the fresh data.
    expect(useSimStore.getState().windowAggregate?.totalRequests).toBe(999);
  });

  it('load() resets windowLoading when a loadWindow is in-flight', async () => {
    const api = new FakeApi();
    useSimStore.getState().attach(api);
    await useSimStore.getState().load();

    // Start a loadWindow but leave it unresolved.
    const staleLoad = useSimStore.getState().loadWindow({ fromMs: 0, toMs: 1000 });
    expect(useSimStore.getState().windowLoading).toBe(true);

    // Reload mid-flight: the loading flag must be cleared immediately so the
    // dock spinner does not get stuck.
    await useSimStore.getState().load();
    expect(useSimStore.getState().windowLoading).toBe(false);

    // Resolve all in-flight promises (agg + window samples + full-run samples)
    // so Promise.all can settle; the stale guard prevents committing the result.
    api.resolveNextWindow();
    api.resolveNextFullRun();
    await staleLoad;
    const s = useSimStore.getState();
    expect(s.windowLoading).toBe(false);
    expect(s.windowAggregate).toBeNull();
    expect(s.windowSamples).toBeNull();
  });

  // ---- fullRunSamples -------------------------------------------------------

  it('loadWindow populates fullRunSamples on the first call', async () => {
    const api = new FakeApi();
    useSimStore.getState().attach(api);
    await useSimStore.getState().load();

    const q: WindowQuery = { fromMs: 0, toMs: 1000 };
    const loading = useSimStore.getState().loadWindow(q);

    // Resolve all three in-flight promises: agg, window samples, full-run samples.
    api.resolveNextWindow(FAKE_AGGREGATE, FAKE_SAMPLES);
    api.resolveNextFullRun(FAKE_FULL_RUN_SAMPLES);
    await loading;

    expect(useSimStore.getState().fullRunSamples).toEqual(FAKE_FULL_RUN_SAMPLES);
  });

  it('loadWindow does not re-fetch fullRunSamples on subsequent calls within the same run', async () => {
    const api = new FakeApi();
    useSimStore.getState().attach(api);
    await useSimStore.getState().load();

    const q: WindowQuery = { fromMs: 0, toMs: 1000 };

    // First loadWindow call: resolves aggregate + 2x latencies (window + full-run).
    const first = useSimStore.getState().loadWindow(q);
    api.resolveNextWindow();
    api.resolveNextFullRun(FAKE_FULL_RUN_SAMPLES);
    await first;
    expect(useSimStore.getState().fullRunSamples).toEqual(FAKE_FULL_RUN_SAMPLES);

    // Second loadWindow call: fullRunSamples is already set, so only aggregate +
    // window samples are fetched (no full-run query).
    const second = useSimStore.getState().loadWindow(q);
    // Only 1 agg + 1 samples in flight; no third resolver is queued.
    expect(api.pendingSamplesCount()).toBe(1);
    api.resolveNextWindow();
    await second;

    // fullRunSamples must remain the value from the first call (not re-fetched).
    expect(useSimStore.getState().fullRunSamples).toEqual(FAKE_FULL_RUN_SAMPLES);
  });

  it('load() clears fullRunSamples so the next run fetches a fresh baseline', async () => {
    const api = new FakeApi();
    useSimStore.getState().attach(api);
    await useSimStore.getState().load();

    // Seed fullRunSamples as if a loadWindow already completed.
    useSimStore.setState({ fullRunSamples: FAKE_FULL_RUN_SAMPLES });
    expect(useSimStore.getState().fullRunSamples).toEqual(FAKE_FULL_RUN_SAMPLES);

    // A fresh load() must clear it.
    await useSimStore.getState().load();
    expect(useSimStore.getState().fullRunSamples).toBeNull();
  });

  // ---- loadInspection -------------------------------------------------------

  it('loadInspection populates inspection and toggles inspectionLoading', async () => {
    const api = new FakeApi();
    useSimStore.getState().attach(api);
    await useSimStore.getState().load();

    const loading = useSimStore.getState().loadInspection(0, 500);
    expect(useSimStore.getState().inspectionLoading).toBe(true);

    api.resolveNextInspection();
    await loading;

    const s = useSimStore.getState();
    expect(s.inspectionLoading).toBe(false);
    expect(s.inspection).toEqual(FAKE_INSPECTION);
  });

  it('superseded loadInspection response does not overwrite a newer one', async () => {
    const api = new FakeApi();
    useSimStore.getState().attach(api);
    await useSimStore.getState().load();

    // Start two in-flight inspection requests.
    const first = useSimStore.getState().loadInspection(0, 100);
    const second = useSimStore.getState().loadInspection(0, 200);

    const firstResult: LbInspection = { ...FAKE_INSPECTION, t: 100 };
    const secondResult: LbInspection = { ...FAKE_INSPECTION, t: 200 };

    // Resolve in issuing order; the second-issued request wins because its
    // captured seq matches the final inspectReqSeq, so the first-issued
    // response is dropped even though it commits-or-drops first.
    api.resolveNextInspection(firstResult); // resolves first request (dropped)
    api.resolveNextInspection(secondResult); // resolves second request (committed)
    await Promise.all([first, second]);

    // The inspection stored should be the second-issued request's result.
    expect(useSimStore.getState().inspection?.t).toBe(200);
  });

  it('inspectReqSeq counter lives in store state (not module globals)', () => {
    // Verify initial state contains the counter.
    const s = useSimStore.getState() as unknown as Record<string, unknown>;
    expect(typeof s.inspectReqSeq).toBe('number');
  });
});
