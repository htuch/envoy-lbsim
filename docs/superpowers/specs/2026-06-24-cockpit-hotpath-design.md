# Cockpit hot/cold-path UX, real-simulator wiring, and Maglev MVP

Status: approved design, ready for an implementation plan.
Date: 2026-06-24.
Scope: turn the existing Track C shell into the final cockpit, wire it to
the real simulator, and land a full working Maglev MVP end to end. Three
parts: (1) the UX restructure we brainstormed (timelines-dominant cockpit
with a scrollable strip stack, a compact fleet-load heatmap as the
in-cockpit topology, a side-by-side Inspector/Window dock, goodput and
stage-split loss strips); (2) replacing the synthetic telemetry worker
with the real `SimController` and feeding the analytical views from real
worker telemetry; (3) driving the real Envoy Maglev LB (compiled to Wasm)
through the kernel so picks and the inspector's Maglev table are real,
not mock. Plus the small protocol and kernel additions those need. The
rest of Track A (ring_hash, the EDF policies, locality bucketing) is
deferred; non-maglev policies keep the mock LB.

## Context: what already exists (do not rebuild)

Track C landed on main (the "C-D view integration"). Already built and
green under the 95% gate:

- Shell `web/src/App.tsx`: a 3-panel layout (config editor; a center
  panel with a `Segmented` switcher over Timelines | Topology | Analysis
  | Inspector; transport bar) over `useSimStore`.
- Worker seam `web/src/worker/`: `client.ts` creates the worker and
  `Comlink.wrap`s it; `loadConfig` returns a `SharedTelemetry` triplet
  and the store builds `GaugeRingBuffer` readers over it. The worker is
  currently SYNTHETIC: `client.ts` line 16 points at
  `./mock-sim-worker.ts`, a `MockSimRunner` that fully implements
  `SimWorkerApi` but paces deterministic harmonic waves into the rings;
  its `queryWindow` returns hardcoded aggregates and its
  `requestInspection` throws. STATUS calls out that the real kernel swaps
  this one URL.
- Store `web/src/store/sim-store.ts` (zustand): `api`, `config`,
  `status`, `rings`, `ready`, `selection` (the committed brushed
  window). Actions: `attach`, `load`, `play/pause/step/seek/setSpeed`,
  `syncStatus` (polls `status()` at 100 ms while running), `setSelection`,
  `setConfig`.
- Hot path `web/src/components/timeline/` + `web/src/lib/{series,
  uplot-opts}.ts`: uPlot strips fed by a `requestAnimationFrame` loop
  reading the rings directly (never through React), with lock-step
  brush-zoom driven by the shared `selection`. Current strips: envoy
  inFlight, envoy queueDepth, backend utilization, backend inFlight,
  client emitRate.
- Transport `web/src/components/transport/TransportBar.tsx`:
  play/pause/step/reset/seek-slider/zoom-reset.
- Config editor `web/src/components/config/ConfigEditor.tsx`: a full
  schema-driven editor, Zod validated, Apply reloads. Keep as-is.
- Views `web/src/components/views/AnalyticalViews.tsx`: hosts the three
  Track D views but feeds each from the `web/src/synthetic/*` generators
  in `useMemo` (`makeTopologySnapshot`, `makeLatencyWindow`,
  `makeInspection`), NOT from worker RPC. `queryWindow` and
  `requestInspection` are unused on the web side today.
- E2E `web/e2e/timeline.spec.ts` (Playwright): live canvas, brush
  highlight, cross-origin isolation.

The Maglev Wasm path is also further along than STATUS implies:
`packages/wasm-lb/bindings/index.ts` exposes `loadLbModule()` returning a
protocol `LbModule` whose `createLb` dispatches `maglev` to the real
`MaglevLoadBalancer` (and throws for other policies); `src/lb.cpp`
implements maglev `chooseHost` and `inspect()` (the latter reveals the
live table via the public hash path). The real Envoy base is lifted, not
shimmed, and a golden node test matches the `lb_core` oracle. The kernel
already assembles a full `LbInspection` in `engine.inspect(envoy)`
(resolved host set + `lb.inspect()` structure), and `SimController`
accepts an `lbModule` option.

Infrastructure in place: COOP/COEP headers (dev, preview, Cloudflare
prod); `vite-plugin-comlink`; `SimController`, `GaugeRingBuffer`, and
`mockLbModule` exported from their packages.

## Goals

1. Wire the real simulator: a real worker that
   `Comlink.expose(new SimController(...))`, swapped in at
   `web/src/worker/client.ts`; feed the analytical views from real worker
   telemetry (gauge frames to topology, `queryWindow` +
   `queryWindowLatencies` to analysis, `requestInspection` to the
   inspector) instead of the synthetic generators.
2. Restructure the shell from the tab switcher into the cockpit:
   timelines are always the hero in a vertically scrollable strip stack;
   the in-cockpit topology collapses to a compact fleet-load heatmap
   (pinned above the scroll) with the full DAGRE graph on demand; the
   analysis and inspector move into a side-by-side right dock with
   `Inspector | Window` tabs that does not displace the timelines.
3. Keep the envoy, backend, and client strips and add goodput and
   stage-split loss strips, surfaced as first-class hot-path series.
4. Land the small protocol and kernel additions (`queryWindowLatencies`,
   a `timedOut` client gauge, and a `rejectRate` double-count fix).
5. Maglev MVP: drive the real Envoy Maglev LB (Wasm) through the kernel
   for the maglev policy, so picks and the inspector's Maglev table are
   real. Non-maglev policies keep the mock LB.

## Non-goals

- Rebuilding the transport, store, config editor, uPlot timeline plumbing,
  or brush-zoom: all exist and stay.
- The rest of Track A: ring_hash, the EDF-base policies
  (round_robin/least_request/random), locality bucketing. Those policies
  keep `mockLbModule`; their inspector structures stay mock-derived.
- Measured per-edge traffic telemetry: topology edges stay structural
  (config-derived shares), labeled as such.
- Retries; zone-aware locality routing.

## Part 1: real-simulator wiring

### 1a. Real worker

Add `web/src/worker/sim-worker.ts` that builds a `SimController` with a
composite LB module (see Part 4 for how maglev gets the real module) and
`Comlink.expose`s it. Point `web/src/worker/client.ts` at it (the
single-URL swap). `SimController` runs playback on its worker-side
`IntervalTicker`, writes gauge frames into the SharedArrayBuffer rings
`loadConfig` returns, and answers `queryWindow`, `queryWindowLatencies`,
and `requestInspection` by deterministic replay. It is deterministic from
the seed.

`web/src/worker/mock-sim-worker.ts`, the `SyntheticModel`, and the
`web/src/synthetic/*` generators stay as test fixtures only; the app and
E2E drive the real worker.

### 1b. Feed the views from real telemetry

`AnalyticalViews`'s synthetic `useMemo` calls are replaced by real data:

- Topology snapshot: a new adapter `web/src/lib/topology-snapshot.ts`
  builds a `TopologySnapshot` from the latest gauge frame per kind (from
  the store's rings) plus structural edges (2c). Recomputed on the
  control-status tick and on selection, not per animation frame.
- Window analysis: on a committed `selection`, call `api.queryWindow(w)`
  (tiles + outcomes) and the new `api.queryWindowLatencies(w)` (CDF +
  histogram) in parallel; the full-run overlay uses the same pair over
  `[0, durationMs]`. These are async RPCs, so the dock carries loading
  and empty states.
- Inspection: on envoy selection (and on pause/step/seek), call
  `api.requestInspection(envoy, vt)` at the cursor instant, not every
  frame (replay is costly); see 2d.

Store additions (`sim-store.ts`): `selectedEnvoy: number`, plus cached
async results with status flags (`windowAggregate`, `windowSamples`,
`windowLoading`; `inspection`, `inspectionLoading`), keyed by inputs so
stale responses are dropped, and a telemetry-handle version guarding
reads after a reload.

## Part 2: cockpit UX restructure

Light "analytical" direction (the existing default shadcn light tokens;
blue primary, green goodput, amber timeouts, red drops and unhealthy).
Tabular numerals.

```
+-- transport: reset play pause step | scrubber (cursor + window band) | speed | t | goodput --+
| ConfigEditor   |  fleet load heatmap (tier rows)  [expand DAGRE]  (pinned) |  dock (resizable)|
|  (existing,    |----------------------------------------------------------|  [Inspector|Win] |
|   the rail)    |  TIMELINES (hero, vertical scroll):                  ^    |  Window: CDF,    |
|                |    envoy:   inFlight, queueDepth, latency p50/p90/p99 |   |   histogram,     |
|                |    backend: utilization, inFlight, latency p50/p90/99 |   |   tiles, outcomes|
|                |    client:  emitRate, inFlight                       |   |  Inspector:      |
|                |    fleet:   goodput, losses by stage                 v    |   hosts + LB     |
+----------------+----------------------------------------------------------+------------------+
```

The `Segmented` switcher in `App.tsx` is removed; timelines are always
visible. `AnalyticalViews` is replaced by `FleetHeatmap` (pinned,
center-top) and `Dock` (right).

### 2a. Fleet-load heatmap (the in-cockpit topology)

`web/src/components/fleet/FleetHeatmap.tsx`. Three tier rows: clients,
envoys, backends. One cell per entity, flexed to fill. Cell fill encodes
instantaneous load on a sequential ramp (light blue to navy), amber at
saturation, a queue tick on overloaded cells, a red inset ring on an
unhealthy backend, a blue ring on the selected entity. Clicking a cell
sets `selectedEnvoy` (envoys) and focuses the Inspector tab. Load per
tier from the latest frame: envoy `inFlight / maxConcurrentRequests`,
backend `utilization` gauge, client `inFlight` normalized. Purely
instantaneous; reads the ring's latest frame on the control tick. An
`expand topology` control opens the existing `TopologyGraph` (full DAGRE)
in a modal/overlay fed by the same `TopologySnapshot`.

### 2b. Timeline strips (scrollable stack)

Keep the envoy, backend, and client strips and add the two fleet-outcome
strips. The stack no longer fits one screen, so the timeline area is a
vertical scroll container; the fleet heatmap and the transport stay
pinned outside it. Each strip has a min-height so it stays legible.
Lock-step brush-zoom and the committed-window handoff apply across the
whole stack, including strips scrolled out of view; brushing any visible
strip commits the window and opens the Window dock tab.

Default stack (data-driven, easy to tune), grouped:
- envoy: inFlight, queueDepth, latency p50/p90/p99 (selected envoy)
- backend: utilization, inFlight, latency p50/p90/p99 (selected backend)
- client: emitRate, inFlight
- fleet: goodput (one green line), losses by stage (timeouts amber,
  envoy rejects indigo, backend shed red)

Per-entity strips keep the existing `buildSeries` path with the selected
entity emphasized. The latency strips (3 percentile series for the
selected entity), goodput (fleet EWMA), and losses (per-stage fleet sums)
need reductions across entities, so add `web/src/lib/derive.ts` with
those builders and a selected-entity series builder.

### 2c. Topology snapshot + structural edges

`TopologySnapshot`, `TopologyNodeStatus`, `TopologyEdge` move from
`web/src/synthetic/topology.ts` to `web/src/components/topology/types.ts`
(now the live view contract). The structural-edge helpers (`makeEdges`,
`clientEnvoyTargets`) move to `web/src/lib/topology-edges.ts`, shared by
the live adapter and the synthetic fixture, so edge logic is defined
once. Edges are structural shares (client LB fan-out, weighted
envoy-to-backend mesh), labeled not-measured.

### 2d. Right dock: Inspector | Window

`web/src/components/dock/Dock.tsx`. A real side-by-side column (not an
overlay) with a drag divider; opening it reflows the timelines narrower,
closing returns full width. Two tabs:

- Inspector: the selected envoy's resolved host set + LB structure at the
  cursor instant via `requestInspection`. Refreshes on selection change
  and on pause/step/seek; during live play shows the last inspected
  instant with a "live" hint and a "snapshot now" action. Reuses
  `LbInspector` unchanged. For maglev this is the real table (Part 4);
  for other policies it is mock-derived (labeled interim).
- Window: the committed window's cold-path analysis (CDF + histogram +
  p50/p90/p99 tiles + outcome breakdown) via `queryWindow` +
  `queryWindowLatencies`; the CDF overlays the full-run distribution
  faintly (solid = window, dashed = full run). Reuses `WindowAnalysis`,
  re-propped (3a).

Selecting an entity focuses Inspector; committing a brush focuses Window.

## Part 3: protocol and kernel additions

Additive or bug fixes; no existing shape reordered or removed. Each
protocol change is mirrored in BOTH the real `SimController` and the
synthetic `MockSimRunner` so the type stays satisfied and the mock's
tests pass.

### 3a. Cold-path latency samples (protocol + controller + mock)

Add to `SimWorkerApi`:

```ts
interface WindowLatencySamples {
  fromMs: number; toMs: number;
  latencies: number[]; // ascending, downsampled, ms
  capped: boolean;     // downsampled from a larger cohort
}
queryWindowLatencies(q: WindowQuery): Promise<WindowLatencySamples>;
```

`SimController` already builds the exact sorted cohort latencies inside
`queryWindow`; the new method returns them, deterministically
downsampled to at most 4000 points via a fixed stride. `queryWindow`
unchanged. `MockSimRunner` implements it against its synthetic
aggregates. `WindowAnalysis` switches its prop from the synthetic
`LatencyWindow` to `{ aggregate, samples }`; its CDF/histogram already
compute from a latency array (`analysis/stats.ts`).

### 3b. Hot-path timeout gauge (protocol + engine + synthetic model)

Append `timedOut` to `CLIENT_GAUGES` (appending is backwards compatible).
`engine.ts` increments a per-interval `client.timedOut` in `onTimeout`
and writes it in the client frame, resetting each tick with
`completed`/`failed`. `failed` stays the total, so
`drops = failed - timedOut` is derivable. `SyntheticModel` adds a
`timedOut` wave to stay schema-complete.

### 3c. Fix the rejectRate timeout double-count (engine bug)

`engine.ts onTimeout` does `envoy.rejects++` (engine.ts:531), polluting
`rejectRate` (documented "shed requests per sample interval") with
timeouts (emitted as phase `timed_out`, not `rejected`). Remove that
increment so `envoy.rejects`/`rejectRate` count only true admission drops
(`envoy_overflow`, `no_healthy_host`). The cold path is already correct.
Regression test: pure-timeout leaves `rejectRate` at zero; pure-overflow
counts rejects.

## Part 4: Maglev MVP

Make the maglev policy real end to end while every other policy keeps the
mock LB.

### 4a. Composite LB module in the worker

`web/src/worker/sim-worker.ts` awaits `loadLbModule()` from
`@elbsim/wasm-lb`, then builds a composite `LbModule` and passes it to
`new SimController({ lbModule })`:

```ts
const real = await loadLbModule();
const lbModule = {
  createLb(policy, common, seed) {
    return policy.kind === 'maglev'
      ? real.createLb(policy, common, seed)
      : mockLbModule.createLb(policy, common, seed);
  },
};
Comlink.expose(new SimController({ lbModule }));
```

`mockLbModule` is exported from `@elbsim/sim-core`. The engine calls
`lbModule.createLb(policy, ...)` per envoy, so maglev envoys get the real
`MaglevLoadBalancer` and the rest get the mock. `chooseHost` then drives
real backend selection for maglev; `engine.inspect` already assembles the
full `LbInspection` from the active instance, so the inspector becomes
real for maglev with no kernel change.

### 4b. Normalize maglev inspect() to the protocol shape

`lb.cpp` maglev `inspect()` returns `{ kind: 'maglev', tableSize, table:
number[] }` (one backend index per slot, built via the public hash path).
The protocol `MaglevInspection` wants `table: Uint32Array` (length ===
tableSize) and `slotCounts: Record<BackendId, number>`. Normalize in the
bindings adapter (`bindings/index.ts` `adapt().inspect()`): when the
returned `kind === 'maglev'`, convert `table` to a `Uint32Array` and
compute `slotCounts` by tallying it. This keeps the C++ minimal and
hands the inspector exactly what `MaglevTableView` already renders
(table + weight-proportional slot shares). Other `kind`s pass through.

### 4c. Build and load the Wasm artifact

The Maglev MVP needs `packages/wasm-lb/build/lb.mjs` + `.wasm`, built by
`pnpm run wasm:build` (needs an activated emsdk; `EMSDK_ENV` if not at
`~/emsdk`). `loadLbModule()` dynamic-imports `../build/lb.mjs`. Validate
early that Vite serves the Emscripten ES module and its `.wasm` to the
worker under cross-origin isolation (the `_headers` note says the `.wasm`
loads under require-corp). Risk: if emsdk is unavailable, the MVP cannot
build; the worker should fail loudly (the existing `loadLbModule` throws
a clear "artifact not built" error) and the app should surface it rather
than silently fall back, so the maglev path is never quietly mocked.

### 4d. Default scenario

Make the default/showcase scenario use the maglev policy so the MVP is
exercised on load (clients to N envoys to P weighted backends), letting a
user immediately see real picks, the live fleet heatmap, and the real
Maglev table in the inspector.

## Data sourcing for goodput, timeouts, and drops

In the timeline stack (no KPI band), from clean signals after the fixes:

| Series         | Source (per sample interval)                              |
|----------------|-----------------------------------------------------------|
| timeouts       | sum of `client.timedOut` (new gauge)                      |
| envoy rejects  | sum of `envoy.rejectRate` (after the double-count fix)    |
| backend shed   | sum of `backend.shed`                                     |
| goodput (live) | EWMA of completed / (completed + timedOut + drops) over   |
|                | the fleet, in `derive.ts`; the exact per-cohort goodput   |
|                | stays in `queryWindow` for the window and the chip.       |

"drops" equals envoy rejects plus backend shed; the strip splits them by
stage. Cumulative goodput is the transport-bar chip.

## Error handling and edge cases

- SharedArrayBuffer unavailable (no cross-origin isolation): the existing
  startup path detects it; keep/extend a clear banner.
- Wasm artifact missing or worker init throws: surface the error
  prominently; do not silently fall maglev back to mock.
- Worker RPC throws (e.g. inspection): the dock shows it inline; the app
  stays live on the last good frame.
- Empty/zero-width brush: ignored (existing threshold).
- Window with zero in-cohort requests: dock shows "no requests in
  window".
- Apply during a seek/replay: Apply stops the ticker and rebuilds; the
  handle version drops reads against the old rings.
- Finished run: transport shows `finished`; play is a no-op until seek.

## Testing

Extend the existing suites; keep the 95% gate.

Unit (Vitest):
- `lib/topology-snapshot.ts`: frame-to-`TopologySnapshot` over a built
  `GaugeRingBuffer`.
- `lib/topology-edges.ts`: structural edges per client LB policy + the
  weighted mesh (relocated tests).
- `lib/derive.ts`: goodput EWMA + stage-split losses from known frames.
- `store/sim-store.ts`: selectedEnvoy, async window/inspection caches
  with stale-drop, handle versioning.
- `components/fleet/FleetHeatmap.tsx`: load mapping, selection, unhealthy
  ring.
- `components/dock/Dock.tsx`: tab focus on selection vs brush-commit;
  loading/empty states.
- timeline strips: derived/selected series render and emphasize the
  selection; scroll container keeps lock-step zoom across offscreen
  strips.

Protocol/sim-core:
- `queryWindowLatencies`: determinism, 4000-cap + `capped`, ascending
  order, percentile agreement with `queryWindow`; mock implements it.
- `timedOut` gauge: populated and reset each tick; synthetic model fills
  it.
- rejectRate fix: pure-timeout zero; pure-overflow counts.

Maglev integration:
- bindings: maglev `inspect()` normalizes to `MaglevInspection`
  (`Uint32Array` table of length tableSize; `slotCounts` tallies the
  table; sums to tableSize). Node test alongside `test/maglev.mjs`.
- the composite LB routes maglev to real and others to mock (unit test
  the composite without instantiating Wasm by stubbing `createLb`).
- a `SimController` test with the real `LbModule` (or a faithful fake)
  confirms `requestInspection` returns a maglev structure for a maglev
  scenario.

E2E (Playwright, per the visual-change rule): extend `web/e2e/` to the
full CUJ against the real worker with the maglev default: load, play,
pause, click a fleet cell (Inspector shows the real Maglev table), brush
a window (Window analysis via `queryWindow` + `queryWindowLatencies`),
seek backward (replay), open the DAGRE topology. Gate the maglev-table
assertion on the artifact being built (skip with a clear message if not,
rather than silently passing).

## Out of scope / follow-ups

- ring_hash, EDF-base policies, locality bucketing (rest of Track A).
- Measured per-edge traffic telemetry.
- Code-splitting the DAGRE and Plot bundles; revisit with routing.
- Per-entity faceted CDFs (the inspector covers per-envoy depth).
- Cross-strip crosshair sync (already a deferred Track C follow-up).

## File-by-file change summary

New:
- `web/src/worker/sim-worker.ts`: real worker; composite LB; expose
  `SimController`.
- `web/src/lib/topology-snapshot.ts`: frame-to-snapshot adapter (+ test).
- `web/src/lib/topology-edges.ts`: structural edges, relocated (+ test).
- `web/src/lib/derive.ts`: goodput + stage-split loss + selected-entity
  series (+ test).
- `web/src/components/fleet/FleetHeatmap.tsx` (+ test).
- `web/src/components/dock/Dock.tsx` (+ test).
- `web/src/components/topology/types.ts`: relocated topology types.
- `web/src/components/topology/TopologyModal.tsx`: DAGRE expand overlay
  wrapping the existing `TopologyGraph`.

Changed:
- `web/src/worker/client.ts`: point at `sim-worker.ts`.
- `web/src/store/sim-store.ts`: `selectedEnvoy`, async window/inspection
  caches, handle versioning.
- `web/src/App.tsx`: cockpit layout (remove the switcher; pinned
  FleetHeatmap + scrollable timeline stack + Dock).
- `web/src/components/timeline/` + `web/src/lib/series.ts`: backend +
  client strips retained, latency/goodput/loss strips added, scroll
  container.
- `web/src/components/transport/TransportBar.tsx`: ensure a speed control
  and the committed-window band on the scrubber.
- `web/src/components/analysis/WindowAnalysis.tsx`: consume
  `{aggregate, samples}` from the worker instead of `LatencyWindow`.
- `web/src/synthetic/topology.ts`: import relocated types + shared edge
  helpers (stays a fixture).
- `packages/protocol/src/worker-rpc.ts`: add `WindowLatencySamples` +
  `queryWindowLatencies`.
- `packages/protocol/src/snapshots.ts`: append `timedOut` to
  `CLIENT_GAUGES`.
- `packages/sim-core/src/controller.ts`: implement `queryWindowLatencies`.
- `packages/sim-core/src/engine.ts`: emit `client.timedOut`; remove the
  `envoy.rejects++` on timeout.
- `packages/wasm-lb/bindings/index.ts`: normalize maglev `inspect()` to
  `MaglevInspection` (`Uint32Array` table + `slotCounts`).
- `web/src/worker/runner.ts` + `web/src/worker/synthetic.ts`: implement
  `queryWindowLatencies` and fill the `timedOut` gauge so the mock stays
  schema-complete.
- default scenario: maglev policy.

Deleted:
- `web/src/components/views/AnalyticalViews.tsx`: replaced by FleetHeatmap
  + Dock (the three view components it hosts are reused).
