# Node CLI wrapper and LB validation suite

Date: 2026-06-24
Status: approved design, pending implementation plan

## Problem

The simulator (`sim-core` kernel + the real Envoy LB in Wasm) can only be
driven through the browser today. There is no way to run a scenario headless,
inspect aggregated stats, or assert that each load balancer behaves as expected.
The one existing headless check, `packages/wasm-lb/test/maglev.mjs`, drives the
LB directly over the Embind ABI; it does not exercise the full simulator or the
stats-aggregation path.

We want a Node CLI that drives the whole simulator from the command line, plus
an extensive validation suite that sanity-checks each load balancer against
expected behaviors. This lets us explore correctness of the simulator, the Wasm
LB, and stats aggregation independent of the frontend.

## Decisions (settled in brainstorming)

- Coverage: validate ALL policies now. Run each through the full kernel using
  real Wasm where the policy is lifted (maglev today) and the mock LB otherwise.
  Every result is labeled REAL or MOCK. Real-only assertions auto-upgrade from
  SKIP to a live check as Track A lifts each policy.
- Primary deliverable: a CLI report. The LB behavioral cases are an exploration
  tool run via the CLI, NOT a merge-blocking CI gate. The new package's own
  library code (driver, stats, formatter) still gets unit tests so the package
  stays green under the repo's 95% coverage gate; that is distinct from gating
  the behavioral outcomes.

## Approach

A new workspace package `packages/cli` (`@elbsim/cli`) exposing an `elbsim`
bin. This matches the monorepo's package-boundary philosophy, gets typecheck,
lint, and test for free, and keeps the kernel library clean. Rejected
alternatives: bolting a CLI onto `sim-core` (mixes a CLI concern into the kernel
and adds coverage-gate friction) and loose `.mjs` scripts under `scripts/`
(matches the existing maglev.mjs idiom but gives up type-checking, lint, and
structure, which is wrong for an extensive suite).

## Components

The package is a set of small, independently testable units.

### 1. Headless driver (`src/driver.ts`)

`runScenario(config, opts)` builds a `SimEngine` directly (no SharedArrayBuffer
rings or playback needed), calls `runToCompletion()`, and returns the raw
`RequestEvent[]` together with the resolved LB label per Envoy policy
(REAL or MOCK). Deterministic from `config.seed`.

- Input: a validated `SimConfig` and `{ lb: LbModule, label: 'real' | 'mock' }`.
- Output: `{ events: readonly RequestEvent[], lbLabel: 'real' | 'mock' }`.
- Depends on: `@elbsim/sim-core` (`SimEngine`), `@elbsim/config`,
  `@elbsim/protocol`.

The driver does not own LB selection; it receives a ready `LbModule` so it stays
trivially testable with the mock.

### 2. LB selection (`src/lb-select.ts`)

`selectLb(policyKind, mode)` returns `{ lb, label }`.

- Loads the real Wasm module once via `loadLbModule()` (lazy, cached).
- `mode` is `auto` (default), `mock`, or `real`.
  - `auto`: use real Wasm if the policy is lifted (maglev today), else mock.
  - `mock`: always the mock.
  - `real`: require real; error if the policy is not lifted or the artifact is
    not built.
- If the Wasm artifact is not built, `auto`/`mock` fall back to the mock with a
  one-line banner (mirrors maglev.mjs's graceful skip); `real` errors clearly.
- A small `LIFTED_POLICIES` set is the single source of truth for which policies
  the real module supports; it expands as Track A lands ring_hash and the EDF
  policies. The current contents are derived from what `loadLbModule().createLb`
  accepts without throwing (maglev only at time of writing).

### 3. Stats (`src/stats.ts`)

Pure functions over `RequestEvent[]`. This is an INDEPENDENT recomputation from
the raw stream, used both for reporting and as the oracle that the production
`queryWindow` aggregation is checked against.

`computeStats(events)` returns:

- `perBackend`: Map backend id to count of `lb_pick` (picks) and `completed`.
- `perEnvoy`: Map envoy id to total picks.
- `outcomes`: `{ completed, timedOut, rejected, total }` over terminal phases.
- `goodput`: completed / total emitted, clamped to [0,1].
- `latencyP50 / P90 / P99`: percentiles over completed `latencyMs`
  (same linear-interpolation method as `SimController`).
- `keyConsistency`: Map request key to the set of backends it was routed to
  (size 1 for a correct consistent-hash policy).

All inputs are plain arrays; no globals; fully unit-tested.

### 4. Case library (`src/cases/`)

Each case is:

```ts
interface LbValidationCase {
  id: string;
  title: string;
  appliesTo: EnvoyLbPolicyKind[];
  build: (policy: EnvoyLbPolicyKind) => SimConfig;
  assert: (stats: Stats, ctx: CaseContext) => Check[];
}

interface Check {
  label: string;
  pass: boolean;
  detail: string;       // observed vs expected, one line
  requiresReal: boolean; // reported SKIP when run on the mock
}
```

`CaseContext` carries `{ lbLabel, policy, config, events }` so a case can drive a
secondary query (e.g. `queryWindow`) when needed.

Planned expectations:

- round_robin: even spread over equal-weight healthy hosts; weighted spread
  (real-only).
- least_request: favors low-active hosts under heterogeneous backend capacity
  (real-only; the mock falls back to round robin).
- random: approximately uniform within a statistical tolerance.
- ring_hash / maglev: key to backend consistency across the whole run; weighted
  distribution and minimal disruption on host removal (real-only).
- all policies (cross-cutting, simulator + stats):
  - goodput in [0,1];
  - lifecycle conservation: emitted == completed + timed_out + rejected at
    completion (no request left dangling);
  - determinism: identical config + seed yields an identical distribution;
  - no traffic to unhealthy hosts (real-only);
  - stats-aggregation cross-check: `SimController.queryWindow` over the full
    horizon agrees with the independent `computeStats` recompute (goodput and
    percentiles within tolerance). This is the case that validates the
    stats-aggregation code the brief calls out, not just the LB.

Real-only checks are reported SKIP with reason "mock LB; awaits Track A lift"
when the resolved label is MOCK, and run live when it is REAL.

### 5. CLI (`bin/elbsim` -> `src/cli.ts`)

Thin arg parsing that delegates to the library. Two subcommands:

- `elbsim run [--scenario name | --config file] [--policy p] [--mock] [--json]`
  Run one scenario and print a dense stats report: per-backend distribution
  table, goodput, latency percentiles, and a REAL/MOCK badge for the LB.
- `elbsim validate [--policy p ...] [--json]`
  Run the case library across the selected policies (all by default). Grouped
  per-policy report with one line per check (PASS / FAIL / SKIP) showing the
  observed-vs-expected detail and a summary footer. Exit nonzero if any
  non-skipped check fails. `--json` emits the structured results.

Scenarios: `--scenario default` resolves to `defaultSimConfig()`; the validation
cases build their own configs via `build()`. `--config file` loads and validates
a JSON `SimConfig` through the Zod schema before running.

### 6. Report formatting (`src/report.ts`)

Pure formatting from the structured results to terminal text (and a `--json`
passthrough). High signal-to-noise, matching the project's visualization
principle: tabular numerals, tight columns, ✓ / ✗ / skip glyphs, a per-policy
group header with the REAL/MOCK badge, and a summary line. Pure and unit-tested
against fixed structured input.

## Data flow

```
SimConfig --(selectLb)--> { lb, label }
          --(runScenario)--> RequestEvent[]
RequestEvent[] --(computeStats)--> Stats
Stats + CaseContext --(case.assert)--> Check[]
Check[] --(report)--> terminal text / JSON
```

`validate` runs this per (policy, case); `run` runs it once and prints stats
without the assert step.

## Error handling

- Wasm artifact missing: banner and fall back to mock for `auto`/`mock`; clear
  error for `real`.
- Unknown scenario name or unreadable/invalid `--config`: print the Zod error
  and exit nonzero before running anything.
- A policy the real module rejects under `--real`: explicit "not lifted yet"
  error naming the policy.
- The driver never throws on normal sim outcomes (timeouts, rejections, panic);
  those are data the cases assert over.

## Testing

The package carries its own vitest suite under the repo 95% coverage gate:

- `stats.test.ts`: pure-function tests over hand-built `RequestEvent[]` fixtures
  (distribution, outcomes, goodput, percentiles, key consistency).
- `report.test.ts`: formatting over fixed structured results, including SKIP and
  FAIL rendering and the `--json` shape.
- `cli.test.ts`: arg parsing and subcommand dispatch (scenario/config/policy
  selection, bad input handling).
- `validate.test.ts`: a STRUCTURAL test that runs `validate` end-to-end against
  the mock for all policies and asserts it executes and emits a well-formed
  report (every case's `build`/`assert` runs). It does NOT assert behavioral
  pass/fail, keeping the suite an exploration tool per the deliverable decision.

The existing `wasm-lb/test/maglev.mjs` LB-level golden test stays as is; this
suite complements it at the full-kernel level rather than replacing it.

## Out of scope (YAGNI)

- An `inspect` subcommand dumping LB structures: deferred until there is a
  concrete need; `requestInspection` already exists and can be added later.
- Gating the behavioral cases in CI: explicitly excluded by the deliverable
  decision.
- Retries, zone-aware routing assertions, slow start: these are not yet
  exercised by the kernel (see STATUS.md follow-ups); cases can be added when
  the kernel supports them.

## Open questions

None blocking. The `LIFTED_POLICIES` set is the one moving part; it is updated in
lockstep with Track A and is the single switch that flips real-only checks from
SKIP to live.
