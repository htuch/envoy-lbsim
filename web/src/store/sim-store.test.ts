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
 */
class FakeApi extends MockSimRunner {
  private _windowResolvers: Array<(v: [WindowAggregate, WindowLatencySamples]) => void> = [];
  private _inspectionResolvers: Array<(v: LbInspection) => void> = [];

  pendingWindowCount(): number {
    return this._windowResolvers.length;
  }

  pendingInspectionCount(): number {
    return this._inspectionResolvers.length;
  }

  /** Override queryWindow to queue a deferred promise. */
  override queryWindow(_q: WindowQuery): Promise<WindowAggregate> {
    // The store calls queryWindow and queryWindowLatencies in parallel;
    // we resolve them together via resolveNextWindow.
    return new Promise((res) => {
      // Pair resolver stored alongside latencies resolver index; this side
      // resolves the aggregate only when resolveNextWindow is called.
      this._windowResolvers.push(([agg]) => res(agg));
    });
  }

  override queryWindowLatencies(_q: WindowQuery): Promise<WindowLatencySamples> {
    return new Promise((res) => {
      this._windowResolvers.push(([_, samples]) => res(samples));
    });
  }

  /** Resolve the oldest pending queryWindow + queryWindowLatencies pair. */
  resolveNextWindow(
    agg: WindowAggregate = FAKE_AGGREGATE,
    samples: WindowLatencySamples = FAKE_SAMPLES,
  ): void {
    // Two resolvers were pushed (one for aggregate, one for samples) -- drain both.
    const r1 = this._windowResolvers.shift();
    const r2 = this._windowResolvers.shift();
    r1?.([agg, samples]);
    r2?.([agg, samples]);
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
    useSimStore.setState({ windowAggregate: FAKE_AGGREGATE, windowSamples: FAKE_SAMPLES });

    await useSimStore.getState().load();
    const s = useSimStore.getState();
    expect(s.windowAggregate).toBeNull();
    expect(s.windowSamples).toBeNull();
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

    // Resolve the fake API calls.
    api.resolveNextWindow();

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

    // Now resolve the OLD (stale) query.
    api.resolveNextWindow();
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

    // Resolving the stale query must not commit its result nor re-raise the flag.
    api.resolveNextWindow();
    await staleLoad;
    const s = useSimStore.getState();
    expect(s.windowLoading).toBe(false);
    expect(s.windowAggregate).toBeNull();
    expect(s.windowSamples).toBeNull();
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
