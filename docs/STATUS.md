# Status

Living document. `/new-session` reads it to start; `/wrap-session` updates it.

## Now

Phase 0 (scaffolding) is complete. Tracks B (simulation kernel), C (frontend
shell + hot path), and D (topology, cold path, inspector) are done, and Track D's
views are now hosted in Track C's real shell (the C-D reconciliation). Track A's
LB lift is complete for the in-scope policies: all five Envoy v1.36.0 load
balancers (maglev, ring_hash, round_robin, least_request, random) are lifted to
Wasm through the real `LoadBalancerBase` / `ThreadAwareLoadBalancerBase` /
`EdfLoadBalancerBase`, each golden-tested, and the real `LbModule` drives the real
`SimEngine` end to end (verified by a sim-core integration test). `sim-core` is a
full discrete-event simulation behind `SimController`; the web app renders live
timelines plus the topology/analysis/inspector views, all driven by the live
store. A headless Node CLI (`@elbsim/cli`) drives the whole simulator and runs a
per-LB validation suite across all five real policies (see the Headless CLI
section). The repo builds, type checks, lints, and tests green under the 95% gate.

The web real-data integration is DONE and the frontend uses the real Wasm LB for
ALL user-accessible features: the app drives the real `SimController` worker
(Comlink + SharedArrayBuffer), composing the real `LbModule` (await
`loadLbModule()`) for all five lifted policies, and every analytical view is fed
from real worker telemetry (`frameToTopologySnapshot` for topology, `queryWindow`
+ `queryWindowLatencies` for cold-path analysis, `requestInspection` for the
inspector). No synthetic generators or mock LB sit in any user-facing path: the
synthetic snapshot/window/inspection generators and the TS mock LB survive only
as test fixtures (`web/src/synthetic/*`, `mockLbModule`, the `MockSimRunner`),
referenced from `*.test.*` only. The shell is the cockpit: timelines-dominant
scrollable strip stack (envoy/backend/client gauges plus goodput and stage-split
loss strips, each labeled with its unit), a compact fleet-load heatmap as the
in-cockpit topology with the full DAGRE graph on demand, and an Inspector |
Window dock. Cockpit interactions: clicking any timeline seeks the inspector to
that virtual instant; clicking an envoy in the heatmap (or topology) selects it
and clicking it again deselects it (selection is nullable); the inspector stacks
the LB structure above the resolved-hosts table in a single scrolling column. The
production build emits `dist/assets/lb.wasm` alongside the hashed LB module.
Verified by a Playwright cockpit CUJ against the real Wasm worker.

Remaining work: optional Track A polish (zone-aware locality bucketing, slow
start). The concrete next step is under "Next step" below.

## Phase 0: scaffolding and interfaces (DONE)

- pnpm workspace; Vite + React 19 app in `web/`; packages `config`, `protocol`,
  `sim-core`, `wasm-lb`.
- Envoy (`v1.36.0`) and abseil (`20260107.1`) added as pinned submodules.
- Tooling: Biome, strict TypeScript, Vitest + 95% coverage gate, lefthook hooks,
  GitHub Actions CI (TS job + Wasm build/golden job + secret scan).
- Durable interfaces written and tested: `SimConfig` schema; event stream;
  gauge ring-buffer layout; worker RPC; Wasm LB ABI; inspection payload.
- `sim-core` foundation: deterministic PRNG, distribution sampling, virtual-time
  event queue, kernel skeleton, and a mock LB implementing the Wasm ABI.
- `wasm-lb`: shim ported from `~/src/lb_core`; Embind EDF smoke module builds to
  Wasm and passes a golden distribution test (real Envoy EDF -> Wasm -> Embind
  -> node).
- App shell renders the default scenario from the shared config.

## Tracks (parallelizable; depend only on Phase 0 interfaces)

### Track A: Wasm LB core
Lift the real Envoy policies to Wasm behind the `LbInstance` ABI.

Done:
- Abseil Wasm gate: `packages/wasm-lb/absl_wasm_sources.txt` (111-file curated
  subset; the base added abseil Cord/CRC + the pthread waiter) links under `em++`.
- The real Envoy LB base is LIFTED, not shimmed: `make build` compiles the
  unmodified `common/{load_balancer_impl,thread_aware_lb_impl,locality_wrr}.cc` +
  `{maglev,ring_hash,round_robin,least_request,random}/*_lb.cc` + `common/hash.cc`
  (murmurHash2), so Envoy's own priority selection, panic threshold,
  healthy/degraded partitioning, locality, weight normalization, the maglev/ketama
  tables, and the EDF scheduler all run for real. The `shim/` headers shadow only
  the leaf interfaces (`upstream.h` Host/HostSet/PrioritySet, stats/runtime/time,
  the request-hashing HTTP path); `types.h`/`phantom.h`/`edf_scheduler.h` stay
  real. No protobuf runtime; `xxhash` 0.8.3 vendored.
- All five policies end-to-end: `src/lb.cpp` builds a concrete `PrioritySet`/
  `HostSet` from `WasmHostSet` (shared `buildPrioritySet` + `LbInstanceBase`) and
  drives the real Envoy LB. The consistent-hash policies are
  `ThreadAwareLoadBalancers` (`ThreadAwareLbInstance`: `initialize()` ->
  `factory()->create()` -> `chooseHost()`); the EDF/random policies are
  `ZoneAwareLoadBalancers` constructed directly and picked via
  `chooseHost(context)` (`ZoneAwareLbInstance`). ABI factories:
  `createMaglevLb`, `createRingHashLb(minRing,maxRing,hashFunction,useHostname,..)`,
  `createRoundRobinLb`,
  `createLeastRequestLb(choiceCount,activeRequestBias,selectionMethod,..)`,
  `createRandomLb`; `updateHosts` now carries `activeRequests` as a 7th vector
  (feeds the lifted base's `host.stats().rq_active_` for least_request).
  `bindings/index.ts` wraps them as the protocol `LbModule`.
- Golden node tests (`pnpm --filter @elbsim/wasm-lb test`): `test/maglev.mjs`
  (slot-for-slot vs the `lb_core` oracle plus distribution/determinism/disruption
  and real-base health/panic/priority), `test/ring_hash.mjs` (consistent routing,
  weight-proportional ownership, minimal disruption on host removal, health/panic,
  xx_hash vs murmur_hash_2), `test/edf.mjs` (round_robin weighted rotation,
  least_request FULL_SCAN/N_CHOICES off live rq_active_, random spread, panic).
- inspect() serializes every `LbStructure` kind: maglev (table probed via the
  public pick path), ring_hash (`RingHashInspection`, ownership sampled from the
  real ring at a bounded grid), round_robin/least_request (`EdfInspection`, the
  serving schedule peeked from a sibling LB with real weights), random
  (`StatelessInspection`). The internal ring/EDF structures are private to the
  lifted source, so inspect() reconstructs them through the public pick path.
- Integration: the real `LbModule` drives the real `SimEngine` for every policy,
  verified by `packages/sim-core/src/engine.wasm.test.ts` (valid routing, seed
  determinism, inspection structure). The engine still defaults to `mockLbModule`
  when no module is injected, so sim-core stays decoupled from wasm-lb at runtime;
  the real module is composed in (await `loadLbModule()`) at the worker layer.

Remaining (optional polish, not blocking):
- Locality buckets: hosts land in one locality per priority today (region/zone are
  passed but not bucketed); wire real `localityWeights()` for zone-aware scenarios.
- Slow start: `TimeSourceImpl` is a fixed clock and the slow-start window is left
  at 0 (disabled); wiring the kernel's virtual clock would enable it.

### Track B: simulation kernel (DONE)
`sim-core` is the full DES. Key files: `engine.ts` (the lifecycle),
`controller.ts` (`SimWorkerApi`), `histogram.ts` (latency), `sampling.ts`
(`createKeySampler`).
- Open-loop client generators (Poisson/periodic/uniform; uniform/cached-Zipf
  keys); client-side LB to Envoys (round_robin/random/hash/subset/dns_approx);
  network legs with a cross-zone penalty; Envoy admission (circuit breaker +
  FIFO/LIFO overflow queue); backend service (capacity/queue/health/per-host
  active counts/service latency); timeouts and goodput.
- Emits the `RequestEvent` stream; writes per-entity gauge frames each
  `sampleIntervalMs`, including appended latency percentile columns.
- Hosts the LB behind the Wasm ABI: `SimEngineOptions.lbModule` (default
  `mockLbModule`) takes either the TS mock or the real Wasm `LbModule`; the real
  one drives the engine for every policy (Track A `engine.wasm.test.ts`).
  `SimController` does play/pause/step/seek (backward seek = deterministic replay
  into the same shared buffers), `queryWindow` (cohort-based cold-path
  aggregates), and `requestInspection` (replay-to-T then `inspect()`).
- Not yet exercised here: retries (see follow-ups); zone-aware locality LB routing
  (locality is plumbed through the ABI, but bucketing is Track A polish). The
  engine feeds live per-host active counts via `updateHosts`, so the real lifted
  least_request reads them at pick time.

### Track C: frontend shell and hot path (DONE)
- Control-panel layout (`web/src/App.tsx`); schema-driven config editor over
  `@elbsim/config` validated through Zod before reload
  (`web/src/components/config/ConfigEditor.tsx`).
- Playback transport (play/pause/step/seek/speed) and a zustand store mirroring
  worker status (`web/src/components/transport/`, `web/src/store/sim-store.ts`).
- Hot path: uPlot gauge strips fed by a `requestAnimationFrame` loop reading the
  SharedArrayBuffer rings directly, never through React
  (`web/src/components/timeline/`, `web/src/lib/series.ts`).
- Lock-step brush-zoom: dragging a window on any strip zooms every strip to the
  same x-window and freezes it while live data streams; a Reset control clears
  it. Driven by one shared `selection` in the store (not uPlot cursor-sync); the
  committed `{fromMs,toMs}` is the handoff to Track D's `queryWindow`.
- Worker wiring (Comlink + SAB): a synthetic telemetry worker implements the
  real `SimWorkerApi` and paces deterministic gauge frames into the rings under
  transport control (`web/src/worker/`). Track B swaps the worker URL in
  `web/src/worker/client.ts`; everything else is unchanged.
A Playwright E2E suite covers the behaviors units cannot (real canvas, the live
brush highlight, cross-origin isolation): `web/e2e/timeline.spec.ts`, run with
`pnpm --filter web test:e2e` (needs the browser once: `test:e2e:install`). Vitest
is scoped to `src/**/*.test.*`, so it does not pick up the `e2e/*.spec.ts` files.
Small follow-ups (not blocking): cross-strip crosshair sync (hover reads the
same x on every gauge) was deliberately deferred to avoid uPlot's select-band
artifact; revisit with a custom cursor-sync that does not mirror the drag select.
Integration done: the app uses the real `SimController` worker
(`web/src/worker/sim-worker.ts`); the synthetic worker (`mock-sim-worker.ts` /
`runner.ts` / `synthetic.ts`) and the `web/src/synthetic/*` generators survive
only as deterministic test fixtures.

### Track D: topology, cold path, inspector (DONE)
Three prop-driven views under `web/src/components/{topology,analysis,inspector}`:
- `@xyflow/react` topology graph (clients -> envoys -> backends, live status).
- Observable Plot cold-path charts over a brushed window (latency CDF/histogram,
  goodput breakdown).
- LB inspector rendering all four `LbStructure` kinds (EDF heap, Maglev table,
  hash ring, stateless) plus the resolved host set + panic badge.
Now hosted in Track C's shell via `web/src/components/views/AnalyticalViews.tsx`
(a visualization switcher in `App.tsx`), fed from the live store (config, playback
time, configured policy, brushed selection). Data is still computed by the
`web/src/synthetic/*` generators (a shared test fixture remains in
`web/src/components/harness/scenario.ts`); see "Remaining" for the real-telemetry
swap. Inspecting Envoy E at time T will call `requestInspection` (deterministic
replay; see Design decisions) once wired to the real worker.

## Headless CLI (`@elbsim/cli`, bin `elbsim`) (DONE)

A headless Node CLI drives the simulator without the frontend. `elbsim run`
prints per-backend distribution, goodput, and latency for a scenario;
`elbsim validate` runs a per-LB validation suite covering expected
distribution, consistency, least-request, and cross-cutting
goodput/conservation/determinism plus a queryWindow-vs-recompute
stats-aggregation cross-check. The default mode is REAL: all five lifted policies
run against the real Wasm LB. `validate` with no --policy covers them all.
`--mock` forces the pure-TS stand-in (round-robin / hash-modulo) for running
without a Wasm build or exercising the simulator/stats path alone; its weaker
fidelity makes weight- and active-count-dependent checks (weighted, favors-idle)
SKIP. `pnpm run wasm:build` self-bootstraps the Envoy and abseil submodules
before building. It is an exploration tool, not a CI gate.

Working invocations (the bin is the entry point; npm scripts delegate to it):

  node packages/cli/bin/elbsim.mjs validate
  node packages/cli/bin/elbsim.mjs validate --policy ring_hash
  node packages/cli/bin/elbsim.mjs run --scenario default --policy least_request
  node packages/cli/bin/elbsim.mjs validate --mock
  node packages/cli/bin/elbsim.mjs run --policy maglev --mock

`LIFTED_POLICIES` in `packages/cli/src/lb-select.ts` is the single source of
truth for which policies have a real Wasm LB (currently all five).

## Next step

Track A's LB lift is done (all five policies, golden-tested, driving the real
engine) and the web real-data integration is done (the cockpit drives the real
`SimController` worker with the real `LbModule` for all policies; views are fed
from real telemetry; `web/src/worker/sim-worker.ts` is the worker, wired at
`web/src/worker/client.ts`). The remaining work is optional Track A polish (not
blocking): zone-aware locality bucketing and slow start (see Track A
"Remaining").

## Integration (after tracks)

Wire real Wasm into the kernel, the real kernel into the UI, and real inspection
payloads into the inspector. The Playwright E2E harness is in place
(`web/e2e/`, started in Track C); extend it across the full journeys (assemble
scenario, run, brush a window, inspect an Envoy) as those land.

## Design decisions (settled)

- LB inspection / time travel: on-demand deterministic replay, not stored
  snapshots. To inspect Envoy E at virtual time T, replay the deterministic run
  to T and call `inspect()`; paused at the cursor that is just `inspect()` with
  no replay. SimController's backward seek and `requestInspection` both work this
  way (the run is a pure function of the seed). EDF state mutates every pick and
  a 65537-slot Maglev table is too heavy to snapshot continuously; periodic
  Wasm-heap checkpoints to bound replay cost are deferred until replay latency is
  shown to hurt.
- Cold-path latency over a brushed window: scan the `RequestEvent` stream via
  `SimWorkerApi.queryWindow` -> `WindowAggregate` (`latencyP50/P90/P99`, goodput,
  success/timeout/rejected). Implemented cohort-based on the requests emitted in
  the window, so goodput is not understated at the trailing edge.
- Hot-path (live) latency timeline (resolved in Track B): a fixed
  log-scale-bucket histogram per Envoy and backend (`histogram.ts`), decayed once
  per sample tick (factor 0.6), feeding the appended latency gauge columns.
  Chosen over per-sample-interval percentiles for robustness on sparse intervals.
- least_request active-count transport (resolved in Track B): the engine keeps
  live per-Envoy per-backend active counts and refreshes the host set via
  `updateHosts` before each pick, so `WasmHost.activeRequests` is current at
  `chooseHost` time. Track A carries it as the `activeRequests` vector into the
  lifted base's `host.stats().rq_active_`, which the real least_request reads at
  pick time; the other policies pass it through but ignore it.
  - POLICY-AWARE refresh (cockpit branch): the per-pick `updateHosts` rebuilt the
    O(65537)-slot Maglev / ring_hash table on every request, making cold-path
    replays O(requests * table). `engine.dispatchUpstream` now refreshes per-pick
    only for least_request (which reads live `rq_active_`); consistent-hash and
    EDF policies build the host set once in `initLbs`, rebuilt only on a backend
    health change. The inspection path still refreshes per-call, so the Inspector
    stays correct.
- Track A LIFTS Envoy's real `LoadBalancerBase` / `ThreadAwareLoadBalancerBase`
  (compiling the base `.cc` untouched) rather than shimming them, so panic/
  priority/locality/weight-normalization are Envoy's own code. An earlier cut
  shimmed the base and resolved the host set in TS; reverted in review as lower
  fidelity and because it left the `WasmHost` health/priority/locality fields
  unused. The cost is shadowing the leaf interfaces the base touches; the same
  base now drives ring_hash and the EDF policies too. The one deliberate stub is
  the request-hashing HTTP path (`HashPolicyImpl`/cookie/header): the kernel
  supplies the hash via `computeHashKey()`, so that subsystem is compile-only.
- C-D frontend reconciliation: Track C and Track D built the frontend on diverged
  branches (origin/main = Track C shell; local main = Track D harness). Resolved
  by basing on the Track C shell and hosting Track D's prop-driven views in it
  (`AnalyticalViews`), keeping the views unchanged. The standalone harness shell
  was dropped; `harnessScenario` survives as a shared test fixture.

## Known follow-ups / decisions on the shelf

- abseil-via-CMake (`emcmake`) is an alternative to the curated source subset if
  cmake is added to the toolchain; not required.
- Retry handling (`timeouts.retries`, per-try timeout) is modeled in config but
  not yet exercised by the kernel. Track B left it deferred.
- Subset LB and slow start are out of the initial lift (subset uses protobuf
  reflection; slow start needs a virtual TimeSource into the LB).
