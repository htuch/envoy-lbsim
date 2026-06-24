# envoy-lb-sim

Interactive, browser-based simulator for exploring the behavior of Envoy's load
balancers. Each simulated Envoy replica runs Envoy's real load balancer code
compiled to WebAssembly, driven over virtual time by a deterministic
discrete-event kernel, with high signal-to-noise visualizations of the
clients -> Envoys -> backends system.

Status: the discrete-event kernel, the React dashboard (live timelines,
topology, analysis, and the LB inspector), and the real Envoy Maglev lifted to
Wasm all exist and are green under test. The remaining work is wiring the real
Wasm LB and kernel into the web app (today it runs against a synthetic worker
and a TypeScript mock LB) and lifting the remaining policies (ring_hash, the
EDF family). See `docs/PRD.md` (why), `docs/ARCHITECTURE.md` (how), and
`docs/STATUS.md` (current state and the parallel work tracks).

## Quick start

```sh
git submodule update --init        # fetch third_party/envoy + abseil
pnpm install
pnpm run typecheck && pnpm run test
pnpm --filter web dev              # the dashboard
```

Building the Wasm LB needs an activated Emscripten SDK; see `CLAUDE.md`.
