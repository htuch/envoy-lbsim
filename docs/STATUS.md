# Status

Living document. `/new-session` reads it to start; `/wrap-session` updates it.

## Now

Phase 0 (scaffolding) is complete. Tracks B (simulation kernel), C (frontend
shell + hot path), and D (topology, cold path, inspector) are done, and Track D's
views are now hosted in Track C's real shell (the C-D reconciliation). Track A is
underway: real Envoy v1.36.0 maglev is lifted to Wasm through the real
`LoadBalancerBase`, validated slot-for-slot against the `lb_core` oracle. `sim-core`
is a full discrete-event simulation behind `SimController`; the web app renders
live timelines plus the topology/analysis/inspector views, all driven by the live
store. The repo builds, type checks, lints, and tests green under the 95% gate.

Remaining work: finish Track A (ring_hash, the EDF policies) and the real-data
integration (swap `mockLbModule` for the real Wasm `LbModule`; feed the analytical
views from real worker telemetry instead of the synthetic generators). The
concrete next step is under "Next step" below.

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
  `maglev/maglev_lb.cc`, so Envoy's own priority selection, panic threshold,
  healthy/degraded partitioning, locality, and weight normalization run for real.
  The `shim/` headers shadow only the leaf interfaces (`upstream.h`
  Host/HostSet/PrioritySet, stats/runtime/time, the request-hashing HTTP path);
  `types.h`/`phantom.h`/`edf_scheduler.h` stay real. No protobuf runtime; `xxhash`
  0.8.3 vendored.
- Maglev end-to-end: `src/lb.cpp` builds a concrete `PrioritySet`/`HostSet` from
  `WasmHostSet` and drives the real `MaglevLoadBalancer` through `initialize()` ->
  `factory()->create()` -> `chooseHost()`. ABI:
  `createMaglevLb(tableSize,useHostname,panicThreshold,overprovisioning,seed)` +
  `updateHosts(backends,weights,healths,priorities,regions,zones)`;
  `bindings/index.ts` wraps it as the protocol `LbModule`. Golden node test
  (`test/maglev.mjs`) matches the `lb_core` oracle slot-for-slot plus
  distribution/determinism/disruption AND real-base fidelity (health filtering,
  panic mode, priority failover).

Remaining:
- ring_hash (derives from the lifted base; compile `ring_hash_lb.cc`; `inspect` ->
  `RingHashInspection`; honor xx_hash/murmur_hash_2).
- EDF-base policies round_robin, least_request, random: the base is already lifted;
  add the `EdfLoadBalancerBase` subclass (same `load_balancer_impl.cc`, already
  compiled) + their config protos (currently empty stubs) + the EDF scheduler.
  `inspect` -> `EdfInspection`. least_request reads `host.stats().rq_active_` in
  the lifted base; wire `WasmHost.activeRequests` through `updateHosts` (now 0).
- Locality buckets: hosts land in one locality per priority today (region/zone are
  passed but not bucketed); wire real `localityWeights()` for zone-aware scenarios.
- Integration: replace `mockLbModule` with the real `LbModule` in the engine, and
  serialize maglev/ring/edf into `inspect()` for the inspector.
Mocks until done: the kernel uses `mockLbModule` for the not-yet-lifted policies.

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
- Hosts the LB behind the Wasm ABI via `mockLbModule`. `SimController` does
  play/pause/step/seek (backward seek = deterministic replay into the same
  shared buffers), `queryWindow` (cohort-based cold-path aggregates), and
  `requestInspection` (replay-to-T then `inspect()`).
- Not yet exercised here: retries (see follow-ups); zone-aware locality LB
  routing logic (locality is plumbed through the ABI, but routing is left to
  Track A); least_request weighting (the mock falls back to round_robin, but the
  engine feeds live per-host active counts so the real policy will work).

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
Mocks until integration: the synthetic worker (`web/src/worker/`) stands in
behind `protocol`; replaced by Track B's kernel worker.

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

## Next step

Two parallel fronts:
- Finish Track A: lift ring_hash from `third_party/envoy/source/extensions/
  load_balancing_policies/ring_hash/ring_hash_lb.{h,cc}` (it derives from the
  already-lifted base, so expect a `ring_hash.pb.h` config shim, compiling
  `ring_hash_lb.cc`, a `RingHashLb` Embind class beside `MaglevLb`, a ring_hash
  case in `bindings/index.ts`, and a golden test mirroring `test/maglev.mjs`).
  Then the EDF policies (round_robin/least_request/random).
- Real-data integration: (a) replace `mockLbModule` with the real Wasm `LbModule`
  in `sim-core` and serialize the live structures into `inspect()`; (b) swap
  `web/`'s synthetic worker for the real `SimController` at
  `web/src/worker/client.ts` (one URL); (c) feed `AnalyticalViews` from real
  worker telemetry (gauge frames -> topology, `queryWindow` -> analysis,
  `requestInspection` -> inspection) instead of the `@/synthetic` generators.

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
  `chooseHost` time. No ABI change was needed. (Track A side: feed it into the
  lifted base's `host.stats().rq_active_` when least_request is lifted; maglev
  passes 0.)
- Track A LIFTS Envoy's real `LoadBalancerBase` / `ThreadAwareLoadBalancerBase`
  (compiling the base `.cc` untouched) rather than shimming them, so panic/
  priority/locality/weight-normalization are Envoy's own code. An earlier cut
  shimmed the base and resolved the host set in TS; reverted in review as lower
  fidelity and because it left the `WasmHost` health/priority/locality fields
  unused. The cost is shadowing the leaf interfaces the base touches; this also
  unblocks ring_hash and the EDF policies (same base). The one deliberate stub is
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
