# envoy-lb-sim

Interactive, browser-based simulator for exploring the behavior of Envoy's load
balancers. Each simulated Envoy replica runs Envoy's real load balancer code
compiled to WebAssembly, driven over virtual time by a deterministic
discrete-event kernel, with high signal-to-noise visualizations of the
clients -> Envoys -> backends system.

Status: the core simulator works end to end. All five Envoy v1.36.0 load
balancers (maglev, ring_hash, round_robin, least_request, random) are lifted to
Wasm and drive the real discrete-event kernel; the React cockpit (live
timelines, fleet topology, cold-path analysis, and the LB inspector) runs
against the real Wasm worker, not a mock; and a headless Node CLI (`elbsim`)
drives the same simulator and runs a per-LB validation suite. Remaining work is
optional polish (zone-aware locality bucketing, slow start). See `docs/PRD.md`
(why), `docs/ARCHITECTURE.md` (how), and `docs/STATUS.md` (current state and the
work tracks).

## Quick start

```sh
git submodule update --init        # fetch third_party/envoy + abseil
pnpm install
pnpm run typecheck && pnpm run test
pnpm --filter web dev              # the dashboard
```

The dashboard and the CLI both serve all five policies from the real Wasm LB,
so build it first (needs an activated Emscripten SDK; see `CLAUDE.md`):

```sh
pnpm run wasm:build                          # build packages/wasm-lb/build/lb.wasm
node packages/cli/bin/elbsim.mjs validate    # headless per-LB validation suite
```
