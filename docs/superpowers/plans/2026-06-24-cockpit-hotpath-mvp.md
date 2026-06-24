# Cockpit hot/cold-path MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing Track C shell into the final cockpit, wire it to the real `SimController`, and drive the real Envoy Maglev LB end to end.

**Architecture:** A Web Worker exposes the real `SimController` over Comlink; the main thread reads SharedArrayBuffer gauge rings in a rAF loop for the hot-path timelines and calls `queryWindow`/`queryWindowLatencies`/`requestInspection` for the cold-path dock. The cockpit replaces the tab switcher: timelines are a scrollable hero stack, the topology collapses to a fleet-load heatmap (full DAGRE on demand), and analysis + inspector share a side-by-side dock. Maglev runs Envoy's real C++ LB compiled to Wasm; other policies keep the mock.

**Tech Stack:** TypeScript, React 19, zustand, uPlot, Observable Plot, @xyflow/react + dagre, Comlink + SharedArrayBuffer, Vitest + Testing Library, Playwright, Emscripten/Wasm (`@elbsim/wasm-lb`), Zod (`@elbsim/config`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-24-cockpit-hotpath-design.md` (read it first).
- Determinism: the simulation is a pure function of `SimConfig.seed`; never introduce `Date.now()`/`Math.random()` into sim or series logic.
- Coverage gate: 95% lines/functions/branches/statements (`pnpm -r run test:cov`). Every new module ships with tests.
- Tooling: `pnpm run typecheck`, `pnpm exec biome check --write .`, `pnpm run test`. No em dashes in prose/comments. No globals.
- Protocol contracts are append-only: add gauges/fields/methods, never reorder or remove. Mirror every `SimWorkerApi` addition in BOTH `SimController` (`packages/sim-core`) and `MockSimRunner` (`web/src/worker/runner.ts`).
- Visual work uses the `frontend-design` skill and matches the committed mockups under `.superpowers/brainstorm/3743470-1782320187/content/` (light "analytical" direction; blue primary, green goodput, amber timeouts, red drops/unhealthy; tabular numerals).
- Run tests synchronously in the foreground. Commit after each task.

---

### Task 1: Protocol additions (latency samples + timedOut gauge)

**Files:**
- Modify: `packages/protocol/src/worker-rpc.ts`
- Modify: `packages/protocol/src/snapshots.ts`
- Test: `packages/protocol/src/contracts.test.ts` (extend) and `packages/protocol/src/snapshots.test.ts` (extend)

**Interfaces:**
- Produces: `interface WindowLatencySamples { fromMs: number; toMs: number; latencies: number[]; capped: boolean }`; `SimWorkerApi.queryWindowLatencies(q: WindowQuery): Promise<WindowLatencySamples>`; `CLIENT_GAUGES` now ends with `'timedOut'`.

- [ ] **Step 1: Write the failing test** in `snapshots.test.ts`:

```ts
import { CLIENT_GAUGES, gaugeFields, gaugeIndex } from './snapshots';

test('client gauges expose timedOut as an appended column', () => {
  expect(CLIENT_GAUGES).toContain('timedOut');
  // appended, not reordered: the original four keep their indices
  expect(gaugeIndex('client', 'emitRate')).toBe(0);
  expect(gaugeIndex('client', 'completed')).toBe(2);
  expect(gaugeIndex('client', 'failed')).toBe(3);
  expect(gaugeIndex('client', 'timedOut')).toBe(gaugeFields('client').length - 1);
});
```

- [ ] **Step 2: Run it, expect FAIL** — `pnpm --filter @elbsim/protocol test -- snapshots` (FAIL: timedOut missing).

- [ ] **Step 3: Implement.** In `snapshots.ts` append to `CLIENT_GAUGES`:

```ts
export const CLIENT_GAUGES = [
  'emitRate',
  'inFlight',
  'completed',
  'failed',
  'timedOut', // requests that exceeded the request timeout this interval
] as const;
```

In `worker-rpc.ts` add the interface and method (after `WindowAggregate`):

```ts
/** Per-request latency samples over a committed window, for the cold-path charts. */
export interface WindowLatencySamples {
  fromMs: number;
  toMs: number;
  /** Ascending completed-request latencies (ms), downsampled to a bounded size. */
  latencies: number[];
  /** True if the cohort was larger than the cap and was downsampled. */
  capped: boolean;
}
```

and in `interface SimWorkerApi`, after `queryWindow`:

```ts
  /** Latency samples over a committed window (CDF/histogram source). */
  queryWindowLatencies(q: WindowQuery): Promise<WindowLatencySamples>;
```

- [ ] **Step 4: Add a contracts test** in `contracts.test.ts` asserting `WindowLatencySamples` is exported and shaped (import the type; build an object literal in a `satisfies WindowLatencySamples` expression).

- [ ] **Step 5: Run, expect PASS** — `pnpm --filter @elbsim/protocol test`. Then `pnpm run typecheck` (will show `SimController`/`MockSimRunner` do not yet implement `queryWindowLatencies`; that is fixed in Tasks 2 and 4, so typecheck stays red until then — acceptable mid-plan; note it).

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(protocol): add queryWindowLatencies and timedOut client gauge"`.

---

### Task 2: SimController.queryWindowLatencies (+ cohort refactor)

**Files:**
- Modify: `packages/sim-core/src/controller.ts`
- Test: `packages/sim-core/src/controller.test.ts` (extend)

**Interfaces:**
- Consumes: `WindowLatencySamples`, `WindowQuery` (Task 1).
- Produces: `SimController.queryWindowLatencies(q): Promise<WindowLatencySamples>`; a private `cohortLatencies(q): number[]` (ascending) factored out of `queryWindow` and reused by both.

- [ ] **Step 1: Write the failing test:**

```ts
test('queryWindowLatencies returns ascending samples agreeing with queryWindow percentiles', async () => {
  const c = new SimController({ ticker: manualTicker() });
  await c.loadConfig(busyConfig()); // a scenario with many completions
  const q = { fromMs: 0, toMs: 2000 };
  const agg = await c.queryWindow(q);
  const s = await c.queryWindowLatencies(q);
  expect(s.fromMs).toBe(0);
  expect(s.latencies.every((v, i, a) => i === 0 || a[i - 1] <= v)).toBe(true);
  expect(s.latencies.length).toBeGreaterThan(0);
  expect(s.latencies.length).toBeLessThanOrEqual(4000);
  // p50 from the samples is within rounding of the aggregate's p50
  const p50 = s.latencies[Math.floor(0.5 * (s.latencies.length - 1))];
  expect(Math.abs(p50 - agg.latencyP50)).toBeLessThan(agg.latencyP50 * 0.2 + 1);
});

test('queryWindowLatencies caps and flags large cohorts', async () => {
  const c = new SimController({ ticker: manualTicker() });
  await c.loadConfig(highVolumeConfig()); // > 4000 completions in window
  const s = await c.queryWindowLatencies({ fromMs: 0, toMs: 1e9 });
  expect(s.latencies.length).toBe(4000);
  expect(s.capped).toBe(true);
});
```

(Reuse existing test config helpers in `controller.test.ts`; if none produce >4000 completions, add a `highVolumeConfig()` local with a high client count/rate and short latency.)

- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter @elbsim/sim-core test -- controller`.

- [ ] **Step 3: Implement.** Refactor the cohort/latency gather out of `queryWindow` into a private method, then add the new method. In `controller.ts`:

```ts
private static readonly SAMPLE_CAP = 4000;

/** Ascending completed-request latencies for requests emitted in the window. */
private cohortLatencies(q: { fromMs: number; toMs: number }): number[] {
  const events = this.fullRun();
  const cohort = new Set<number>();
  const completedLatency = new Map<number, number>();
  for (const e of events) {
    if (e.phase === 'emitted' && e.t >= q.fromMs && e.t <= q.toMs) cohort.add(e.req);
    else if (e.phase === 'completed') completedLatency.set(e.req, e.latencyMs);
  }
  const latencies: number[] = [];
  for (const req of cohort) {
    const l = completedLatency.get(req);
    if (l !== undefined) latencies.push(l);
  }
  latencies.sort((a, b) => a - b);
  return latencies;
}

async queryWindowLatencies(q: { fromMs: number; toMs: number }): Promise<WindowLatencySamples> {
  const sorted = this.cohortLatencies(q);
  const cap = SimController.SAMPLE_CAP;
  let latencies = sorted;
  let capped = false;
  if (sorted.length > cap) {
    // Deterministic uniform stride downsample; keeps shape and determinism.
    latencies = new Array(cap);
    for (let i = 0; i < cap; i++) latencies[i] = sorted[Math.floor((i * sorted.length) / cap)] as number;
    capped = true;
  }
  return { fromMs: q.fromMs, toMs: q.toMs, latencies, capped };
}
```

Then change `queryWindow` to compute its `latencies` via `this.cohortLatencies(q)` instead of the inline loop (keep its existing terminal-outcome counting for completed/timedOut/rejected; only the latency-gathering is shared). Import `WindowLatencySamples` from `@elbsim/protocol`.

- [ ] **Step 4: Run, expect PASS** — `pnpm --filter @elbsim/sim-core test -- controller`.

- [ ] **Step 5: Commit** — `git commit -am "feat(sim-core): SimController.queryWindowLatencies with deterministic cap"`.

---

### Task 3: Engine timedOut gauge + rejectRate fix

**Files:**
- Modify: `packages/sim-core/src/engine.ts`
- Test: `packages/sim-core/src/engine.test.ts` (extend)

**Interfaces:**
- Produces: `client.timedOut` populated each sample interval and reset; `envoy.rejects` no longer incremented on timeout.

- [ ] **Step 1: Write the failing tests:**

```ts
test('a pure-timeout scenario leaves envoy rejectRate at zero', () => {
  // backends slow enough that every request times out, queues large enough that
  // nothing is shed at admission.
  const { engine } = runScenario(timeoutOnlyConfig());
  const envoyFrames = collectFrames(engine, 'envoy');
  const rej = gaugeIndex('envoy', 'rejectRate');
  expect(envoyFrames.some((f) => f.values.some((_v, i) => i % stride === rej && _v > 0))).toBe(false);
});

test('client.timedOut counts timeouts per interval and resets', () => {
  const { engine } = runScenario(timeoutOnlyConfig());
  const clientFrames = collectFrames(engine, 'client');
  const idx = gaugeIndex('client', 'timedOut');
  const total = sumGauge(clientFrames, 'client', 'timedOut');
  expect(total).toBeGreaterThan(0);
});
```

(Use the existing engine-test harness helpers; add `timeoutOnlyConfig()` locally: tiny request timeout, backend latency well above it, generous envoy/backend queues.)

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** In `engine.ts`:
  1. Add `timedOut: number; // this interval` to the `ClientState` shape and initialize to `0` where clients are constructed (near `completed: 0, failed: 0`).
  2. In `onTimeout`, after `client.failed++` add `client.timedOut++`, and DELETE the line `envoy.rejects++` (the `const envoy = ...` line above it becomes unused — remove it too).
  3. In the client gauge-sampling block (where `emitRate/inFlight/completed/failed` are written and `completed`/`failed` reset), add:

```ts
row[o + gaugeIndex('client', 'timedOut')] = c.timedOut;
// ... after writing:
c.timedOut = 0;
```

- [ ] **Step 4: Run, expect PASS** — `pnpm --filter @elbsim/sim-core test -- engine`. Confirm no other engine test regressed (timeouts previously inflated rejectRate; if a prior test asserted that, update it to the corrected semantics and note why in the commit).

- [ ] **Step 5: Commit** — `git commit -am "fix(sim-core): count client.timedOut; stop double-counting timeouts as rejects"`.

---

### Task 4: Mock worker stays schema-complete

**Files:**
- Modify: `web/src/worker/runner.ts` (implement `queryWindowLatencies`)
- Modify: `web/src/worker/synthetic.ts` (fill the `timedOut` gauge wave)
- Test: `web/src/worker/runner.test.ts`, `web/src/worker/synthetic.test.ts` (extend)

**Interfaces:**
- Consumes: `WindowLatencySamples` (Task 1).
- Produces: `MockSimRunner.queryWindowLatencies` returns a bounded ascending synthetic sample set; synthetic client frames include a `timedOut` column.

- [ ] **Step 1: Write failing tests** asserting (a) `runner.queryWindowLatencies({fromMs,toMs})` returns ascending `latencies` with `length <= 4000` and a boolean `capped`, and (b) the synthetic model writes a non-constant `timedOut` value into client frames (so `gaugeIndex('client','timedOut')` reads a finite number).

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** In `runner.ts`, add:

```ts
async queryWindowLatencies(q: WindowQuery): Promise<WindowLatencySamples> {
  // Synthesize from the same fixed percentiles the mock's queryWindow uses:
  // draw a deterministic lognormal-ish ramp between p50 and p99, bounded.
  const n = Math.min(2000, /* derived from span * fleet rate */ this.windowSampleCount(q));
  const xs = Array.from({ length: n }, (_, i) => this.sampleLatency(i / Math.max(1, n - 1)));
  xs.sort((a, b) => a - b);
  return { fromMs: q.fromMs, toMs: q.toMs, latencies: xs, capped: false };
}
```

Implement `sampleLatency(u)` as a monotone map hitting the mock's fixed P50/P90/P99 (12/38/92 ms) so charts look plausible; `windowSampleCount` from the existing synthetic fleet-rate math already used by `queryWindow`. In `synthetic.ts`, add a `timedOut` wave to the per-client gauge generation (small, bounded, like `failed`) so `fillFrame('client', ...)` writes the new column.

- [ ] **Step 4: Run, expect PASS** — `pnpm --filter web test -- worker`.

- [ ] **Step 5: Run typecheck** — `pnpm run typecheck` should now be GREEN again (both `SimWorkerApi` implementors satisfy the new method).

- [ ] **Step 6: Commit** — `git commit -am "feat(web): mock worker implements queryWindowLatencies and timedOut gauge"`.

---

### Task 5: Normalize maglev inspect() to MaglevInspection

**Files:**
- Modify: `packages/wasm-lb/bindings/index.ts` (the `adapt().inspect()` wrapper)
- Test: `packages/wasm-lb/bindings/index.test.ts` (create)

**Interfaces:**
- Produces: `adapt(...).inspect()` returns a protocol `LbStructure`; for `kind === 'maglev'` it is a `MaglevInspection` with `table: Uint32Array` (length === tableSize) and `slotCounts: Record<number, number>` tallying the table.

- [ ] **Step 1: Write the failing test** (no Wasm needed: drive the normalizer with a fake `EmbindLb` whose `inspect()` returns a raw val):

```ts
import { normalizeStructure } from './index';

test('maglev inspect raw val becomes a MaglevInspection', () => {
  const raw = { kind: 'maglev', tableSize: 5, table: [0, 1, 0, 2, 1] };
  const s = normalizeStructure(raw);
  expect(s.kind).toBe('maglev');
  if (s.kind !== 'maglev') throw new Error('kind');
  expect(s.table).toBeInstanceOf(Uint32Array);
  expect(Array.from(s.table)).toEqual([0, 1, 0, 2, 1]);
  expect(s.tableSize).toBe(5);
  expect(s.slotCounts).toEqual({ 0: 2, 1: 2, 2: 1 });
});

test('non-maglev structures pass through unchanged', () => {
  expect(normalizeStructure({ kind: 'none' })).toEqual({ kind: 'none' });
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm --filter @elbsim/wasm-lb test` (add a `test` script using vitest if the package lacks one; otherwise run via the workspace runner).

- [ ] **Step 3: Implement.** Export a pure `normalizeStructure(raw: unknown): LbStructure` in `index.ts` and call it from `adapt().inspect()`:

```ts
export function normalizeStructure(raw: any): LbStructure {
  if (raw && raw.kind === 'maglev') {
    const table = Uint32Array.from(raw.table as number[]);
    const slotCounts: Record<number, number> = {};
    for (const b of table) slotCounts[b] = (slotCounts[b] ?? 0) + 1;
    return { kind: 'maglev', tableSize: raw.tableSize, table, slotCounts };
  }
  return raw as LbStructure;
}
```

and change `inspect()` to `return normalizeStructure(lb.inspect());`.

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit** — `git commit -am "feat(wasm-lb): normalize maglev inspect() to MaglevInspection"`.

---

### Task 6: Real worker + composite LB + artifact

**Files:**
- Create: `web/src/worker/sim-worker.ts`
- Create: `web/src/worker/composite-lb.ts`
- Modify: `web/src/worker/client.ts` (worker URL)
- Test: `web/src/worker/composite-lb.test.ts`
- Build: `pnpm run wasm:build`

**Interfaces:**
- Consumes: `loadLbModule` (`@elbsim/wasm-lb`), `mockLbModule`, `SimController` (`@elbsim/sim-core`).
- Produces: `makeCompositeLbModule(real: LbModule, mock: LbModule): LbModule` routing `maglev` to `real`, all else to `mock`; a worker that `Comlink.expose`s a `SimController` driven by the composite.

- [ ] **Step 1: Write the failing test** for the composite (no Wasm: stub both modules):

```ts
import { makeCompositeLbModule } from './composite-lb';

test('composite routes maglev to real and others to mock', () => {
  const calls: string[] = [];
  const real = { createLb: (p) => (calls.push(`real:${p.kind}`), {} as any) };
  const mock = { createLb: (p) => (calls.push(`mock:${p.kind}`), {} as any) };
  const c = makeCompositeLbModule(real as any, mock as any);
  c.createLb({ kind: 'maglev', tableSize: 7 } as any, {} as any, 1);
  c.createLb({ kind: 'round_robin' } as any, {} as any, 1);
  expect(calls).toEqual(['real:maglev', 'mock:round_robin']);
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** `composite-lb.ts`:

```ts
import type { CommonLbConfig, EnvoyLbPolicy } from '@elbsim/config';
import type { LbInstance, LbModule } from '@elbsim/protocol';

export function makeCompositeLbModule(real: LbModule, mock: LbModule): LbModule {
  return {
    createLb(policy: EnvoyLbPolicy, common: CommonLbConfig, seed: number): LbInstance {
      return policy.kind === 'maglev'
        ? real.createLb(policy, common, seed)
        : mock.createLb(policy, common, seed);
    },
  };
}
```

and `sim-worker.ts`:

```ts
import * as Comlink from 'comlink';
import { loadLbModule } from '@elbsim/wasm-lb';
import { mockLbModule, SimController } from '@elbsim/sim-core';
import { makeCompositeLbModule } from './composite-lb';

const real = await loadLbModule(); // throws clearly if the artifact is not built
const lbModule = makeCompositeLbModule(real, mockLbModule);
Comlink.expose(new SimController({ lbModule }));
```

In `client.ts`, change the worker URL from `./mock-sim-worker.ts` to `./sim-worker.ts` (keep the rest of `createSimWorker` unchanged).

- [ ] **Step 4: Build the Wasm artifact** — `pnpm run wasm:build` (needs an activated emsdk; set `EMSDK_ENV` if not at `~/emsdk`). Confirm `packages/wasm-lb/build/lb.mjs` and `.wasm` exist. If emsdk is unavailable, STOP and surface this: the wiring is correct but the MVP cannot run; report it for a human to build, and continue the web-only tasks meanwhile.

- [ ] **Step 5: Run** — `pnpm --filter web test -- composite-lb` (PASS), then `pnpm --filter web dev` and confirm in the browser the worker loads (network shows `lb.wasm`, no console error) and timelines stream. If the Emscripten ESM import fails under Vite, add the artifact to `optimizeDeps.exclude` / `assetsInclude` for `.wasm` as needed (validate this early; document the fix).

- [ ] **Step 6: Commit** — `git commit -am "feat(web): real SimController worker with composite maglev LB"`.

---

### Task 7: Relocate topology types + shared edge helpers

**Files:**
- Create: `web/src/components/topology/types.ts`
- Create: `web/src/lib/topology-edges.ts`
- Modify: `web/src/synthetic/topology.ts` (import the relocated types + edge helpers)
- Modify: importers of `TopologySnapshot`/`TopologyNodeStatus`/`TopologyEdge` (`TopologyGraph.tsx`, `layout.ts`, `AnalyticalViews.tsx`, tests) to import from the new location
- Test: `web/src/lib/topology-edges.test.ts` (move the edge cases from `synthetic/topology.test.ts`)

**Interfaces:**
- Produces: `web/src/components/topology/types.ts` exporting `TopologySnapshot`, `TopologyNodeStatus`, `TopologyEdge`; `web/src/lib/topology-edges.ts` exporting `makeEdges(config, rng): TopologyEdge[]` and `clientEnvoyTargets(config, client, rng): number[]` (moved verbatim from `synthetic/topology.ts`).

- [ ] **Step 1:** Write `topology-edges.test.ts` covering each client LB policy branch and the weighted backend mesh (copy the assertions currently in `synthetic/topology.test.ts` that target edges).
- [ ] **Step 2: Run, expect FAIL** (module not found).
- [ ] **Step 3:** Move the three interfaces into `components/topology/types.ts`; move `makeEdges`/`clientEnvoyTargets` into `lib/topology-edges.ts` (they take `(config, rng)` / `(config, client, rng)` exactly as today). Re-export or import them back into `synthetic/topology.ts` so `makeTopologySnapshot` still works as a fixture. Update all imports (`grep -rl "TopologySnapshot\|TopologyNodeStatus\|TopologyEdge\|makeEdges\|clientEnvoyTargets" web/src`).
- [ ] **Step 4: Run, expect PASS** — `pnpm --filter web test -- topology` and `pnpm run typecheck`.
- [ ] **Step 5: Commit** — `git commit -am "refactor(web): relocate topology view types and structural-edge helpers"`.

---

### Task 8: Live topology-snapshot adapter

**Files:**
- Create: `web/src/lib/topology-snapshot.ts`
- Test: `web/src/lib/topology-snapshot.test.ts`

**Interfaces:**
- Consumes: `TopologySnapshot`/`TopologyNodeStatus` (Task 7), `makeEdges` (Task 7), `GaugeRingBuffer`, `gaugeIndex`, `resolveBackend` (`@elbsim/config`).
- Produces: `frameToTopologySnapshot(config: SimConfig, rings: Map<EntityKind, GaugeRingBuffer>, seed?: number): TopologySnapshot` reading each ring's latest frame; returns a zeroed-but-valid snapshot when a ring is empty.

- [ ] **Step 1: Write the failing test:** build rings with `GaugeRingBuffer.alloc(spec)`, `push` one frame with known gauge values (set envoy `inFlight`, backend `utilization`, backend `health`, envoy `panic`), call `frameToTopologySnapshot`, assert node `utilization`/`health`/`panic`/`queueDepth` map from the right gauge columns and `edges.length` matches `makeEdges`.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** Read `rings.get(kind)?.latest()`; for each entity index build a `TopologyNodeStatus` pulling `inFlight`/`queueDepth` from gauges, `utilization` from the backend `utilization` gauge (envoys: `inFlight / queue.maxConcurrentRequests`; clients: normalized `inFlight`), `health` from the backend `health` gauge ordinal (clients/envoys 0), `panic` from the envoy `panic` gauge (>0.5), `queueCapacity`/`region`/`zone` from `config`/`resolveBackend`. Edges from `makeEdges(config, new Prng(seed ?? config.seed))`. Empty ring → all-zero nodes (still render).

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit** — `git commit -am "feat(web): frame-to-TopologySnapshot adapter for live telemetry"`.

---

### Task 9: Derived hot-path series (goodput, losses, selected-entity)

**Files:**
- Create: `web/src/lib/derive.ts`
- Test: `web/src/lib/derive.test.ts`

**Interfaces:**
- Consumes: `GaugeRingBuffer`, `gaugeIndex`, `Series` (from `lib/series.ts`).
- Produces:
  - `goodputSeries(rings, alpha?): { x: number[]; y: number[] }` — per-frame fleet goodput EWMA in [0,1].
  - `lossSeries(rings): { x: number[]; timeouts: number[]; envoyRejects: number[]; backendShed: number[] }` — per-frame fleet sums.
  - `selectedSeries(ring, gaugeIndex, entity): { x: number[]; y: number[] }` — one entity's column.

- [ ] **Step 1: Write failing tests** over hand-built rings (client ring with known `completed`/`timedOut`/`failed`; envoy ring with `rejectRate`; backend ring with `shed`). Assert: `goodputSeries` is `completed/(completed+timedOut+drops)` smoothed and clamped to [0,1]; `lossSeries` sums match the per-frame totals; `selectedSeries(ring, idx, 1)` equals entity 1's column.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** the three functions. Goodput per frame: sum client `completed`/`timedOut`, sum `(failed - timedOut)` for drops across clients, plus envoy `rejectRate` and backend `shed` if you prefer the stage view, then EWMA with `alpha` default `0.3`, clamp `[0,1]`, guard divide-by-zero (no traffic → carry previous or 1). Losses: per-frame fleet sums of `client.timedOut`, `envoy.rejectRate`, `backend.shed`. Keep allocations out of any future hot loop (these are called on data-change, like `buildSeries`).

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit** — `git commit -am "feat(web): derived goodput, stage-split loss, and selected-entity series"`.

---

### Task 10: Store additions (selectedEnvoy + async caches)

**Files:**
- Modify: `web/src/store/sim-store.ts`
- Test: `web/src/store/sim-store.test.ts` (extend)

**Interfaces:**
- Produces, added to `SimStore`:
  - `selectedEnvoy: number` + `setSelectedEnvoy(i: number): void`
  - `windowAggregate: WindowAggregate | null; windowSamples: WindowLatencySamples | null; windowLoading: boolean`
  - `inspection: LbInspection | null; inspectionLoading: boolean`
  - `loadWindow(q: WindowQuery): Promise<void>` (calls `queryWindow` + `queryWindowLatencies` in parallel, drops stale by comparing the q it was called with against the latest `selection`)
  - `loadInspection(envoy: number, tMs: number): Promise<void>` (calls `requestInspection`, drops stale by a monotonic request id)
  - a `handle` version integer bumped in `load()` so reads after a reload are dropped.

- [ ] **Step 1: Write failing tests** with a fake `api`: `setSelectedEnvoy` updates state; `loadWindow` populates `windowAggregate`/`windowSamples` and toggles `windowLoading`; a stale `loadWindow` whose `selection` changed before resolution does NOT overwrite the newer result; `loadInspection` populates `inspection`; `load()` bumps `handle` and clears caches.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** Add the fields (init `selectedEnvoy: 0`, caches `null`, loading `false`, `handle: 0`). `load()` sets `handle: get().handle + 1` and clears `windowAggregate/windowSamples/inspection`. `loadWindow(q)` captures `const h = get().handle`, sets `windowLoading: true`, awaits `Promise.all([api.queryWindow(q), api.queryWindowLatencies(q)])`, and only commits if `get().handle === h && get().selection === q-or-equivalent`. `loadInspection` uses a private incrementing `inspectReqId` closure (module-level `let` is fine inside the store factory, not a true global). Keep the hot path untouched.

- [ ] **Step 4: Run, expect PASS** — `pnpm --filter web test -- sim-store`.

- [ ] **Step 5: Commit** — `git commit -am "feat(web): store selectedEnvoy and async window/inspection caches"`.

---

### Task 11: WindowAnalysis consumes worker data

**Files:**
- Modify: `web/src/components/analysis/WindowAnalysis.tsx`
- Test: `web/src/components/analysis/WindowAnalysis.test.tsx` (update)

**Interfaces:**
- Consumes: `WindowAggregate`, `WindowLatencySamples`.
- Produces: `WindowAnalysis({ aggregate, samples, fullRunSamples? })` rendering CDF + histogram from `samples.latencies`, tiles/outcomes from `aggregate`, and a faint full-run overlay from `fullRunSamples` when present.

- [ ] **Step 1: Update the test** to pass `{ aggregate, samples }` (build a `WindowAggregate` literal and a `WindowLatencySamples` literal) and assert the CDF/histogram/tiles render (query by text for p50/p90/p99 values and outcome counts).
- [ ] **Step 2: Run, expect FAIL** (prop shape changed).
- [ ] **Step 3: Implement.** Swap the prop from `LatencyWindow` to `{ aggregate, samples, fullRunSamples? }`. Feed `latencyCdf(samples.latencies)` and the histogram from `samples.latencies`; tiles and `outcomeBreakdown` from `aggregate`. Add the dashed full-run CDF line from `fullRunSamples` when provided (solid = window, dashed = full run). Keep the existing `stats.ts` helpers.
- [ ] **Step 4: Run, expect PASS** — `pnpm --filter web test -- WindowAnalysis`.
- [ ] **Step 5: Commit** — `git commit -am "feat(web): WindowAnalysis renders from worker aggregate + samples"`.

---

### Task 12: FleetHeatmap component

**Files:**
- Create: `web/src/components/fleet/FleetHeatmap.tsx`
- Test: `web/src/components/fleet/FleetHeatmap.test.tsx`

**Interfaces:**
- Consumes: `TopologySnapshot` (Task 7).
- Produces: `FleetHeatmap({ snapshot, selectedEnvoy, onSelectEnvoy })` rendering three tier rows of cells; cell fill from `utilization` (sequential ramp, amber at >=1), red ring on unhealthy backend (`health >= 2`), blue ring on the selected envoy, queue tick when `queueDepth > 0`; clicking an envoy cell calls `onSelectEnvoy(index)`.

- [ ] **Step 1: Write the failing test** (use `frontend-design` for the actual markup, but the test fixes behavior): render with a snapshot where envoy 2 is selected, backend 1 unhealthy, envoy 0 saturated; assert there are `clients+envoys+backends` cells (`getAllByRole('button')` for clickable envoy cells), the unhealthy backend cell has the `data-unhealthy` attribute, clicking envoy cell 3 fires `onSelectEnvoy(3)`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** with the `frontend-design` skill, matching `final-v2.html`/`rhs-dock.html` mockups: a `data-tier` row per kind, cells as buttons for envoys (clickable) and static for clients/backends, fill via a `loadColor(u)` helper (export it; unit-test the ramp boundaries), `data-unhealthy`/`data-selected` attributes for the rings, a queue tick element when `queueDepth>0`. Tabular numerals, dense, light tokens.
- [ ] **Step 4: Run, expect PASS** — `pnpm --filter web test -- FleetHeatmap`.
- [ ] **Step 5: Commit** — `git commit -am "feat(web): compact fleet-load heatmap (in-cockpit topology)"`.

---

### Task 13: Dock (Inspector | Window) + TopologyModal

**Files:**
- Create: `web/src/components/dock/Dock.tsx`
- Create: `web/src/components/topology/TopologyModal.tsx`
- Test: `web/src/components/dock/Dock.test.tsx`

**Interfaces:**
- Consumes: store (`selectedEnvoy`, `selection`, window/inspection caches + `loadWindow`/`loadInspection`), `LbInspector`, `WindowAnalysis` (Task 11), `TopologyGraph`, `frameToTopologySnapshot` (Task 8).
- Produces: `Dock()` (a resizable right column with `Inspector | Window` tabs, loading/empty states, focusing Window on a new `selection` and Inspector on a `selectedEnvoy` change); `TopologyModal({ open, snapshot, onClose, selectedEnvoy, onSelectEnvoy })` wrapping `TopologyGraph`.

- [ ] **Step 1: Write the failing test:** with a store seeded so `selection` is set, render `Dock` and assert it shows the Window tab active and calls `loadWindow`; set `selectedEnvoy` and clear selection and assert it focuses Inspector and calls `loadInspection`; assert a loading state renders while the cache is null+loading, and an empty state ("no requests in window") when the aggregate has `totalRequests === 0`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** with `frontend-design`, matching `final-v2.html` dock: tabs, a drag divider (a simple width state is fine), reuse `LbInspector` (pass `store.inspection`) and `WindowAnalysis` (pass `{aggregate, samples}` from the store; also fetch full-run samples once per run for the overlay). Wire effects: on `selection` change call `loadWindow` and focus Window; on `selectedEnvoy` or pause/step/seek call `loadInspection(selectedEnvoy, status.virtualTimeMs)` and focus Inspector. `TopologyModal` renders `TopologyGraph` full-bleed with a close button.
- [ ] **Step 4: Run, expect PASS** — `pnpm --filter web test -- Dock`.
- [ ] **Step 5: Commit** — `git commit -am "feat(web): side-by-side Inspector|Window dock and DAGRE topology modal"`.

---

### Task 14: Cockpit layout (scrollable strips + heatmap + dock)

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/timeline/TimelineStrip.tsx` and `web/src/lib/uplot-opts.ts` if the latency/goodput/loss strips need a multi-series-from-derive path
- Delete: `web/src/components/views/AnalyticalViews.tsx`
- Test: `web/src/App.test.tsx` (update)

**Interfaces:**
- Consumes: `FleetHeatmap` (Task 12), `Dock` (Task 13), `frameToTopologySnapshot` (Task 8), derived series (Task 9), `useSimStore`.
- Produces: the cockpit shell: transport (top), `ConfigEditor` rail (left), pinned `FleetHeatmap` + scrollable timeline stack (center), `Dock` (right), `TopologyModal` toggled from the heatmap's expand control.

- [ ] **Step 1: Update `App.test.tsx`** to assert the switcher is gone, the heatmap and timelines and dock all render simultaneously (no tab gating), and the strip stack contains the new strips (query by strip label text: "goodput", "losses by stage", "latency p50").
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** with `frontend-design`, matching `final-v2.html`: remove the `Segmented` switcher and `AnalyticalViews`; lay out transport/rail/center/dock; make the center a pinned `FleetHeatmap` over a `overflow-y-auto` timeline container; render the strip stack grouped (envoy inFlight/queueDepth/latency, backend utilization/inFlight/latency, client emitRate/inFlight, fleet goodput/losses). The latency/goodput/loss strips render via a small `DerivedStrip`/extended `TimelineStrip` that takes a series builder from `derive.ts` (keep the rAF read pattern). Wire the heatmap's `onSelectEnvoy` to `setSelectedEnvoy`, the expand control to open `TopologyModal` with `frameToTopologySnapshot(config, rings)`. Delete `AnalyticalViews.tsx` and its imports.
- [ ] **Step 4: Run, expect PASS** — `pnpm --filter web test -- App`. Then `pnpm run typecheck` + `pnpm exec biome check --write .`.
- [ ] **Step 5: Commit** — `git commit -am "feat(web): cockpit layout with scrollable strips, fleet heatmap, dock"`.

---

### Task 15: Transport speed control + window band; default scenario maglev

**Files:**
- Modify: `web/src/components/transport/TransportBar.tsx`
- Modify: the default scenario source (`web/src/components/harness/scenario.ts` fixture and/or `defaultSimConfig` usage in `main.tsx`/store) so the app boots on maglev
- Test: `web/src/components/transport/TransportBar.test.tsx` (extend)

**Interfaces:**
- Produces: a speed selector in the transport calling `setSpeed`; a committed-window band overlay on the scrubber when `selection` is set; the app's initial config uses `policy.kind === 'maglev'`.

- [ ] **Step 1: Write failing tests:** a speed control renders and calling it dispatches `setSpeed(2)`; when `selection` is set the scrubber shows a `data-window-band`; the initial store config (or the boot config in `main.tsx`) has `envoys.policy.kind === 'maglev'`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Add a speed `Segmented`/select (0.25x..8x) bound to `setSpeed`; overlay a band on the seek track from `selection.fromMs/toMs` over `duration`. Set the boot config to maglev (prefer adjusting the scenario the app loads in `main.tsx`, not `defaultSimConfig` in `@elbsim/config`, unless that is the intended default; if changing `defaultSimConfig`, update its existing tests).
- [ ] **Step 4: Run, expect PASS** — `pnpm --filter web test -- TransportBar`.
- [ ] **Step 5: Commit** — `git commit -am "feat(web): transport speed control + window band; default to maglev"`.

---

### Task 16: E2E CUJ against the real worker

**Files:**
- Modify/Create: `web/e2e/cockpit.spec.ts`
- Test: the spec itself

**Interfaces:**
- Consumes: the running app (real worker).

- [ ] **Step 1: Write the E2E** (`web/e2e/cockpit.spec.ts`): load the app; assert cross-origin isolation (`crossOriginIsolated === true`); click play then pause; click an envoy cell in the fleet heatmap and assert the Inspector tab shows a host row and, IF the Wasm artifact is present, a Maglev table (gate this assertion: `test.skip(!fs.existsSync('packages/wasm-lb/build/lb.mjs'), 'wasm not built')`); brush a window on a timeline and assert the Window tab shows p50/p90/p99 tiles; click reset/seek-back and assert the clock returns; open the DAGRE topology modal and assert nodes render.
- [ ] **Step 2: Run** — `pnpm --filter web test:e2e` (install browser once with `test:e2e:install`). Expect PASS (maglev-table assertion skipped if unbuilt).
- [ ] **Step 3: Commit** — `git commit -am "test(web): e2e cockpit CUJ against the real worker"`.

---

### Task 17: Docs + full green sweep

**Files:**
- Modify: `docs/STATUS.md`
- Test: full suite

- [ ] **Step 1:** Update `docs/STATUS.md`: Track C+D real-data integration done; Maglev MVP integrated (real LB + real inspector table); remaining Track A = ring_hash/EDF/locality.
- [ ] **Step 2: Run the full gate** — `pnpm run typecheck`, `pnpm exec biome ci .`, `pnpm -r run test:cov` (95% gate), `pnpm --filter web build`. Fix any coverage gaps in the new modules.
- [ ] **Step 3: Commit** — `git commit -am "docs: STATUS for cockpit + Maglev MVP integration"`.

---

## Self-Review

- Spec coverage: Part 1 -> Tasks 6,8,10,11,13,14. Part 2 -> Tasks 7,8,9,12,13,14,15. Part 3 -> Tasks 1,2,3,4. Part 4 -> Tasks 5,6,15. Testing/E2E -> Tasks 16,17. Data sourcing -> Task 9. No spec section is unmapped.
- Type consistency: `WindowLatencySamples`/`queryWindowLatencies` (T1) are consumed unchanged in T2/T4/T10/T11; `frameToTopologySnapshot` (T8) consumed in T13/T14; `makeCompositeLbModule` (T6) signature matches its test; `normalizeStructure` (T5) returns `LbStructure`.
- Known mid-plan red: typecheck is red between T1 and T4 (the two `SimWorkerApi` implementors gain the method in T2 and T4). Called out in T1/T4.
- Risk: T6 Step 4 (emsdk build / Vite Wasm-in-worker). If blocked, web Tasks 7-15 still land; Maglev lights up once the artifact builds.
