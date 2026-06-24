# Node CLI wrapper and LB validation suite - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Node CLI (`@elbsim/cli`, bin `elbsim`) that drives the simulator headless and runs an extensive per-LB validation suite, exploring simulator, Wasm LB, and stats-aggregation correctness independent of the frontend.

**Architecture:** A new workspace package `packages/cli` with small, single-responsibility modules: a headless driver over `SimEngine`, an LB selector (real Wasm where a policy is lifted, mock otherwise, each labeled REAL/MOCK), pure stats functions over the `RequestEvent` stream, a case library of expected LB behaviors, a runner, a report formatter, and a thin CLI entry. The behavioral cases run via the CLI; the package's own library code is unit-tested under the 95% coverage gate.

**Tech Stack:** TypeScript (ESM, strict), pnpm workspace, Vitest (+ v8 coverage), tsx (to run the TS CLI), Biome. Depends on `@elbsim/config`, `@elbsim/protocol`, `@elbsim/sim-core`, `@elbsim/wasm-lb`.

## Global Constraints

- Node >= 22; ESM only (`"type": "module"`), `verbatimModuleSyntax` on: use `import type` for type-only imports.
- TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`: array indexing yields `T | undefined`; never pass `undefined` to an optional property, omit it instead (use conditional spread `...(x ? { k: x } : {})`).
- Biome: single quotes, semicolons always, 2-space indent, line width 100. Run `pnpm exec biome check --write .` before committing.
- Coverage gate per package: 95% lines/functions/branches/statements via `vitest run --coverage`. Coverage excludes `src/index.ts` and `**/*.test.ts`; the `bin/` shim lives outside `src/` so it is not measured.
- Determinism: every simulated run is a pure function of `SimConfig.seed`. Do not introduce wall-clock or `Math.random`.
- No globals (project rule). Pass dependencies as parameters (e.g. injectable `loadReal`, `Io`).
- The validation behavioral cases are NOT a CI gate; only the package's library unit tests gate CI.
- Commit messages: terse, no emojis, no markdown, no em dashes, wrapped at 72 cols.

---

## File structure

```
packages/cli/
  package.json              @elbsim/cli; bin elbsim; scripts; deps
  tsconfig.json             extends ../../tsconfig.base.json
  vitest.config.ts          node env, v8 coverage, 95% gate
  bin/elbsim.mjs            tsx-registering shim -> src/cli.ts main()
  src/
    index.ts                re-exports the public library surface
    driver.ts               runScenario(config, lb) -> events
    stats.ts                computeStats(events) -> Stats (pure)
    lb-select.ts            selectLb(policy, mode, deps) -> { module, label, note? }
    report.ts               formatValidationReport / formatRunReport / jsonReplacer
    validate.ts             runValidation(policies, mode, deps, cases) -> ValidationResult
    cli.ts                  main(argv, io, deps) -> exit code; flag parsing
    cases/
      types.ts              LbValidationCase, Check, CaseContext, ALL_POLICIES
      scenario.ts           scenario(policy, opts) -> SimConfig builder
      cross-cutting.ts      goodput/conservation/determinism/stats-agg/unhealthy
      distribution.ts       even (RR), weighted (real), uniform (random)
      consistency.ts        key->single-backend (ring_hash/maglev)
      least-request.ts      favors idle hosts (real)
      index.ts              ALL_CASES registry
    *.test.ts               co-located unit tests
```

---

### Task 1: Scaffold the `@elbsim/cli` package

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/vitest.config.ts`
- Create: `packages/cli/src/index.ts`
- Create: `packages/cli/bin/elbsim.mjs`
- Test: `packages/cli/src/smoke.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: the package `@elbsim/cli`; `bin/elbsim.mjs` invoking `main` from `src/cli.ts` (added in Task 10); `src/index.ts` as the public re-export barrel.

- [ ] **Step 1: Write package.json**

```json
{
  "name": "@elbsim/cli",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "elbsim": "./bin/elbsim.mjs" },
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "test:cov": "vitest run --coverage",
    "elbsim": "tsx src/cli.ts",
    "validate": "tsx src/cli.ts validate",
    "sim": "tsx src/cli.ts run"
  },
  "dependencies": {
    "@elbsim/config": "workspace:*",
    "@elbsim/protocol": "workspace:*",
    "@elbsim/sim-core": "workspace:*",
    "@elbsim/wasm-lb": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^24.13.2",
    "tsx": "^4.19.2"
  }
}
```

- [ ] **Step 2: Write tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src", "bin"]
}
```

- [ ] **Step 3: Write vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', '**/*.test.ts'],
      thresholds: { lines: 95, functions: 95, branches: 95, statements: 95 },
    },
  },
});
```

- [ ] **Step 4: Write bin/elbsim.mjs**

```js
#!/usr/bin/env node
// Thin launcher: register tsx so the TypeScript CLI and its workspace `.ts`
// imports run directly, then dispatch to main(). Lives outside src/ so it is
// not under the coverage gate.
import { register } from 'tsx/esm/api';
register();
const { main } = await import('../src/cli.ts');
process.exit(await main(process.argv.slice(2)));
```

- [ ] **Step 5: Write src/index.ts (public barrel)**

```ts
export * from './driver';
export * from './stats';
export * from './lb-select';
export * from './validate';
export * from './report';
export * from './cases/types';
```

- [ ] **Step 6: Write a smoke test so vitest has a file**

`packages/cli/src/smoke.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

describe('@elbsim/cli scaffold', () => {
  it('runs vitest', () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 7: Install and verify typecheck + test**

Run:
```bash
pnpm install
pnpm --filter @elbsim/cli typecheck
pnpm --filter @elbsim/cli test
```
Expected: install succeeds (adds tsx); typecheck passes; vitest runs 1 passing test.

Note: `src/index.ts` re-exports modules created in later tasks. If typecheck fails here because those files do not exist yet, temporarily reduce `src/index.ts` to `export {};` and restore the full barrel in Task 10 Step (final). Prefer creating the barrel incrementally: at this task, set `src/index.ts` to `export {};` and add each re-export as its module lands.

- [ ] **Step 8: Commit**

```bash
git add packages/cli pnpm-lock.yaml
git commit -m "cli: scaffold @elbsim/cli package"
```

---

### Task 2: Stats module

**Files:**
- Create: `packages/cli/src/stats.ts`
- Test: `packages/cli/src/stats.test.ts`

**Interfaces:**
- Consumes: `RequestEvent` from `@elbsim/protocol`.
- Produces:
  - `interface BackendCount { picks: number; completed: number }`
  - `interface Outcomes { completed: number; timedOut: number; rejected: number; total: number }`
  - `interface Stats { perBackend: Map<number, BackendCount>; perEnvoy: Map<number, number>; outcomes: Outcomes; goodput: number; latencyP50: number; latencyP90: number; latencyP99: number; keyConsistency: Map<number, Set<number>> }`
  - `function computeStats(events: readonly RequestEvent[]): Stats`

- [ ] **Step 1: Write the failing test**

`packages/cli/src/stats.test.ts`:

```ts
import type { RequestEvent } from '@elbsim/protocol';
import { describe, expect, it } from 'vitest';
import { computeStats } from './stats';

function lifecycle(req: number, key: number, envoy: number, backend: number, latencyMs: number): RequestEvent[] {
  return [
    { t: 0, req, phase: 'emitted', client: 0, key },
    { t: 1, req, phase: 'lb_pick', envoy, backend, attempts: 1 },
    { t: 2, req, phase: 'completed', backend, latencyMs },
  ];
}

describe('computeStats', () => {
  it('counts picks, completions, outcomes and goodput', () => {
    const events: RequestEvent[] = [
      ...lifecycle(0, 7, 0, 1, 10),
      ...lifecycle(1, 7, 0, 1, 20),
      ...lifecycle(2, 9, 1, 2, 30),
      { t: 0, req: 3, phase: 'emitted', client: 0, key: 5 },
      { t: 1, req: 3, phase: 'lb_pick', envoy: 0, backend: 1, attempts: 1 },
      { t: 2, req: 3, phase: 'timed_out', reason: 'timeout' },
      { t: 0, req: 4, phase: 'emitted', client: 0, key: 5 },
      { t: 1, req: 4, phase: 'rejected', reason: 'envoy_overflow', envoy: 0 },
    ];
    const s = computeStats(events);
    expect(s.outcomes).toEqual({ completed: 3, timedOut: 1, rejected: 1, total: 5 });
    expect(s.goodput).toBeCloseTo(3 / 5, 10);
    expect(s.perBackend.get(1)).toEqual({ picks: 3, completed: 2 });
    expect(s.perBackend.get(2)).toEqual({ picks: 1, completed: 1 });
    expect(s.perEnvoy.get(0)).toBe(3);
    expect(s.perEnvoy.get(1)).toBe(1);
    expect(s.keyConsistency.get(7)).toEqual(new Set([1]));
    expect(s.keyConsistency.get(9)).toEqual(new Set([2]));
  });

  it('computes interpolated percentiles over completed latencies', () => {
    const events: RequestEvent[] = [
      ...lifecycle(0, 1, 0, 0, 10),
      ...lifecycle(1, 2, 0, 0, 20),
      ...lifecycle(2, 3, 0, 0, 30),
    ];
    const s = computeStats(events);
    expect(s.latencyP50).toBeCloseTo(20, 10);
  });

  it('returns zeroed goodput and percentiles for an empty stream', () => {
    const s = computeStats([]);
    expect(s.goodput).toBe(0);
    expect(s.latencyP99).toBe(0);
    expect(s.outcomes.total).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @elbsim/cli test stats`
Expected: FAIL with "Failed to resolve import './stats'" / `computeStats is not defined`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/stats.ts`:

```ts
import type { RequestEvent } from '@elbsim/protocol';

export interface BackendCount {
  picks: number;
  completed: number;
}

export interface Outcomes {
  completed: number;
  timedOut: number;
  rejected: number;
  total: number;
}

export interface Stats {
  perBackend: Map<number, BackendCount>;
  perEnvoy: Map<number, number>;
  outcomes: Outcomes;
  goodput: number;
  latencyP50: number;
  latencyP90: number;
  latencyP99: number;
  keyConsistency: Map<number, Set<number>>;
}

/** Linear-interpolated percentile over an ascending-sorted array; 0 if empty. */
function percentile(sorted: readonly number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const rank = q * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const frac = rank - lo;
  return (sorted[lo] as number) * (1 - frac) + (sorted[hi] as number) * frac;
}

/**
 * Independent recomputation of run stats from the raw cold-path event stream.
 * Pure: the same events always yield the same Stats. Used both for reporting and
 * as the oracle the production `queryWindow` aggregation is checked against.
 */
export function computeStats(events: readonly RequestEvent[]): Stats {
  const perBackend = new Map<number, BackendCount>();
  const perEnvoy = new Map<number, number>();
  const reqKey = new Map<number, number>();
  const keyConsistency = new Map<number, Set<number>>();
  const latencies: number[] = [];
  let emitted = 0;
  let completed = 0;
  let timedOut = 0;
  let rejected = 0;

  const backend = (b: number): BackendCount => {
    let c = perBackend.get(b);
    if (!c) {
      c = { picks: 0, completed: 0 };
      perBackend.set(b, c);
    }
    return c;
  };

  for (const e of events) {
    switch (e.phase) {
      case 'emitted':
        emitted++;
        reqKey.set(e.req, e.key);
        break;
      case 'lb_pick': {
        backend(e.backend).picks++;
        perEnvoy.set(e.envoy, (perEnvoy.get(e.envoy) ?? 0) + 1);
        const key = reqKey.get(e.req);
        if (key !== undefined) {
          let set = keyConsistency.get(key);
          if (!set) {
            set = new Set<number>();
            keyConsistency.set(key, set);
          }
          set.add(e.backend);
        }
        break;
      }
      case 'completed':
        completed++;
        backend(e.backend).completed++;
        latencies.push(e.latencyMs);
        break;
      case 'timed_out':
        timedOut++;
        break;
      case 'rejected':
        rejected++;
        break;
    }
  }

  latencies.sort((a, b) => a - b);
  const total = emitted;
  return {
    perBackend,
    perEnvoy,
    outcomes: { completed, timedOut, rejected, total },
    goodput: total === 0 ? 0 : Math.max(0, Math.min(1, completed / total)),
    latencyP50: percentile(latencies, 0.5),
    latencyP90: percentile(latencies, 0.9),
    latencyP99: percentile(latencies, 0.99),
    keyConsistency,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @elbsim/cli test stats`
Expected: PASS (3 tests).

- [ ] **Step 5: Add `export * from './stats';` to `src/index.ts` and commit**

```bash
git add packages/cli/src/stats.ts packages/cli/src/stats.test.ts packages/cli/src/index.ts
git commit -m "cli: add pure stats recompute over the event stream"
```

---

### Task 3: Headless driver

**Files:**
- Create: `packages/cli/src/driver.ts`
- Test: `packages/cli/src/driver.test.ts`

**Interfaces:**
- Consumes: `SimConfig` from `@elbsim/config`; `LbModule`, `RequestEvent` from `@elbsim/protocol`; `SimEngine`, `mockLbModule` from `@elbsim/sim-core`.
- Produces:
  - `type LbLabel = 'real' | 'mock'`
  - `interface SelectedLb { module: LbModule; label: LbLabel; note?: string }` (the shape selectLb returns in Task 4; declared here because driver consumes `{ module, label }`)
  - `interface RunResult { events: readonly RequestEvent[]; lbLabel: LbLabel }`
  - `function runScenario(config: SimConfig, lb: { module: LbModule; label: LbLabel }): RunResult`

- [ ] **Step 1: Write the failing test**

`packages/cli/src/driver.test.ts`:

```ts
import { defaultSimConfig } from '@elbsim/config';
import { mockLbModule } from '@elbsim/sim-core';
import { describe, expect, it } from 'vitest';
import { runScenario } from './driver';

describe('runScenario', () => {
  const cfg = { ...defaultSimConfig(), time: { durationMs: 2_000, sampleIntervalMs: 50 } };

  it('runs to completion and returns a non-empty deterministic event stream', () => {
    const a = runScenario(cfg, { module: mockLbModule, label: 'mock' });
    const b = runScenario(cfg, { module: mockLbModule, label: 'mock' });
    expect(a.lbLabel).toBe('mock');
    expect(a.events.length).toBeGreaterThan(0);
    expect(a.events.length).toBe(b.events.length);
    expect(a.events.some((e) => e.phase === 'lb_pick')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @elbsim/cli test driver`
Expected: FAIL with unresolved `./driver`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/driver.ts`:

```ts
import type { SimConfig } from '@elbsim/config';
import type { LbModule, RequestEvent } from '@elbsim/protocol';
import { SimEngine } from '@elbsim/sim-core';

/** Which LB implementation produced a run: real Envoy Wasm, or the TS mock. */
export type LbLabel = 'real' | 'mock';

/** A resolved LB choice (returned by selectLb in lb-select.ts). */
export interface SelectedLb {
  module: LbModule;
  label: LbLabel;
  note?: string;
}

export interface RunResult {
  events: readonly RequestEvent[];
  lbLabel: LbLabel;
}

/**
 * Drive one scenario to completion headless and return its cold-path event
 * stream. No SharedArrayBuffer rings or playback: a plain SimEngine run, which
 * is a pure function of `config.seed` and the LB module.
 */
export function runScenario(config: SimConfig, lb: { module: LbModule; label: LbLabel }): RunResult {
  const engine = new SimEngine(config, { lbModule: lb.module });
  engine.runToCompletion();
  return { events: engine.events, lbLabel: lb.label };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @elbsim/cli test driver`
Expected: PASS.

- [ ] **Step 5: Add `export * from './driver';` to `src/index.ts` and commit**

```bash
git add packages/cli/src/driver.ts packages/cli/src/driver.test.ts packages/cli/src/index.ts
git commit -m "cli: add headless SimEngine driver"
```

---

### Task 4: LB selection

**Files:**
- Create: `packages/cli/src/lb-select.ts`
- Test: `packages/cli/src/lb-select.test.ts`

**Interfaces:**
- Consumes: `EnvoyLbPolicyKind` from `@elbsim/config`; `LbModule` from `@elbsim/protocol`; `mockLbModule` from `@elbsim/sim-core`; `loadLbModule` from `@elbsim/wasm-lb`; `LbLabel`, `SelectedLb` from `./driver`.
- Produces:
  - `const LIFTED_POLICIES: ReadonlySet<EnvoyLbPolicyKind>`
  - `type LbMode = 'auto' | 'mock' | 'real'`
  - `interface SelectDeps { loadReal: () => Promise<LbModule | undefined> }`
  - `function selectLb(policy: EnvoyLbPolicyKind, mode: LbMode, deps?: SelectDeps): Promise<SelectedLb>`

- [ ] **Step 1: Write the failing test**

`packages/cli/src/lb-select.test.ts`:

```ts
import type { LbModule } from '@elbsim/protocol';
import { mockLbModule } from '@elbsim/sim-core';
import { describe, expect, it } from 'vitest';
import { LIFTED_POLICIES, selectLb } from './lb-select';

const fakeReal = mockLbModule as unknown as LbModule; // a stand-in "real" module
const present = { loadReal: async () => fakeReal };
const absent = { loadReal: async () => undefined };

describe('selectLb', () => {
  it('mode mock always returns the mock', async () => {
    const s = await selectLb('maglev', 'mock', present);
    expect(s.label).toBe('mock');
    expect(s.module).toBe(mockLbModule);
  });

  it('mode auto uses real for a lifted policy when the artifact is present', async () => {
    const s = await selectLb('maglev', 'auto', present);
    expect(s.label).toBe('real');
    expect(s.module).toBe(fakeReal);
  });

  it('mode auto falls back to mock with a note for an unlifted policy', async () => {
    const s = await selectLb('round_robin', 'auto', present);
    expect(s.label).toBe('mock');
    expect(s.note).toMatch(/not lifted/);
  });

  it('mode auto falls back to mock with a note when the artifact is absent', async () => {
    const s = await selectLb('maglev', 'auto', absent);
    expect(s.label).toBe('mock');
    expect(s.note).toMatch(/not built/);
  });

  it('mode real throws for an unlifted policy', async () => {
    await expect(selectLb('random', 'real', present)).rejects.toThrow(/not lifted/);
  });

  it('mode real throws when the artifact is absent', async () => {
    await expect(selectLb('maglev', 'real', absent)).rejects.toThrow(/not built/);
  });

  it('mode real returns the real module when present', async () => {
    const s = await selectLb('maglev', 'real', present);
    expect(s.label).toBe('real');
  });

  it('exposes maglev as a lifted policy', () => {
    expect(LIFTED_POLICIES.has('maglev')).toBe(true);
    expect(LIFTED_POLICIES.has('ring_hash')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @elbsim/cli test lb-select`
Expected: FAIL with unresolved `./lb-select`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/lb-select.ts`:

```ts
import type { EnvoyLbPolicyKind } from '@elbsim/config';
import type { LbModule } from '@elbsim/protocol';
import { mockLbModule } from '@elbsim/sim-core';
import { loadLbModule } from '@elbsim/wasm-lb';
import type { SelectedLb } from './driver';

/**
 * Policies the real Wasm module currently supports. Single source of truth for
 * REAL vs MOCK selection; expand in lockstep with Track A (ring_hash, then the
 * EDF policies). Flips real-only validation checks from SKIP to live.
 */
export const LIFTED_POLICIES: ReadonlySet<EnvoyLbPolicyKind> = new Set<EnvoyLbPolicyKind>([
  'maglev',
]);

export type LbMode = 'auto' | 'mock' | 'real';

/** Injectable loader so tests can supply a fake real module without emsdk. */
export interface SelectDeps {
  loadReal: () => Promise<LbModule | undefined>;
}

const defaultDeps: SelectDeps = {
  async loadReal() {
    try {
      return await loadLbModule();
    } catch {
      return undefined; // artifact not built
    }
  },
};

/**
 * Resolve which LB module to drive a policy with. `mock` forces the mock;
 * `real` requires real Wasm (errors if the policy is unlifted or unbuilt);
 * `auto` prefers real for lifted policies and otherwise falls back to the mock
 * with an explanatory note.
 */
export async function selectLb(
  policy: EnvoyLbPolicyKind,
  mode: LbMode,
  deps: SelectDeps = defaultDeps,
): Promise<SelectedLb> {
  if (mode === 'mock') return { module: mockLbModule, label: 'mock' };

  const lifted = LIFTED_POLICIES.has(policy);

  if (mode === 'real') {
    if (!lifted) throw new Error(`policy '${policy}' is not lifted to real Wasm yet`);
    const real = await deps.loadReal();
    if (!real) {
      throw new Error('wasm-lb artifact not built; run `pnpm --filter @elbsim/wasm-lb build`');
    }
    return { module: real, label: 'real' };
  }

  // auto
  if (!lifted) {
    return { module: mockLbModule, label: 'mock', note: `policy '${policy}' not lifted; using mock LB` };
  }
  const real = await deps.loadReal();
  if (!real) {
    return { module: mockLbModule, label: 'mock', note: 'wasm-lb artifact not built; using mock LB' };
  }
  return { module: real, label: 'real' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @elbsim/cli test lb-select`
Expected: PASS (8 tests).

- [ ] **Step 5: Add `export * from './lb-select';` to `src/index.ts` and commit**

```bash
git add packages/cli/src/lb-select.ts packages/cli/src/lb-select.test.ts packages/cli/src/index.ts
git commit -m "cli: add real/mock LB selection with injectable loader"
```

---

### Task 5: Case types and scenario builder

**Files:**
- Create: `packages/cli/src/cases/types.ts`
- Create: `packages/cli/src/cases/scenario.ts`
- Test: `packages/cli/src/cases/scenario.test.ts`

**Interfaces:**
- Consumes: `SimConfig`, `EnvoyLbPolicyKind`, `SimConfig` schema parser from `@elbsim/config`; `RequestEvent`, `LbModule` from `@elbsim/protocol`; `Stats` from `../stats`; `LbLabel` from `../driver`.
- Produces:
  - `interface Check { label: string; pass: boolean; detail: string; requiresReal: boolean }`
  - `interface CaseContext { policy: EnvoyLbPolicyKind; config: SimConfig; lbLabel: LbLabel; lbModule: LbModule; events: readonly RequestEvent[] }`
  - `interface LbValidationCase { id: string; title: string; appliesTo: readonly EnvoyLbPolicyKind[]; build: (policy: EnvoyLbPolicyKind) => SimConfig; assert: (stats: Stats, ctx: CaseContext) => Check[] }`
  - `const ALL_POLICIES: readonly EnvoyLbPolicyKind[]`
  - `interface ScenarioOpts { backends?: number; durationMs?: number; ratePerSec?: number; overrides?: Record<string, unknown> }`
  - `function scenario(policy: EnvoyLbPolicyKind, opts?: ScenarioOpts): SimConfig`

- [ ] **Step 1: Write the failing test**

`packages/cli/src/cases/scenario.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { scenario } from './scenario';

describe('scenario', () => {
  it('builds a valid SimConfig for a policy with sane defaults', () => {
    const cfg = scenario('maglev');
    expect(cfg.envoys.policy.kind).toBe('maglev');
    expect(cfg.backends.count).toBe(6);
    expect(cfg.time.durationMs).toBe(5_000);
  });

  it('applies backend overrides (e.g. an unhealthy host)', () => {
    const cfg = scenario('round_robin', { backends: 4, overrides: { '0': { health: 'unhealthy' } } });
    expect(cfg.backends.count).toBe(4);
    expect(cfg.backends.overrides['0']?.health).toBe('unhealthy');
  });

  it('is deterministic in shape across calls', () => {
    expect(scenario('random')).toEqual(scenario('random'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @elbsim/cli test scenario`
Expected: FAIL with unresolved `./scenario`.

- [ ] **Step 3: Write cases/types.ts**

`packages/cli/src/cases/types.ts`:

```ts
import type { EnvoyLbPolicyKind, SimConfig } from '@elbsim/config';
import type { LbModule, RequestEvent } from '@elbsim/protocol';
import type { LbLabel } from '../driver';
import type { Stats } from '../stats';

/** A single asserted property of a run. `requiresReal` checks SKIP on the mock. */
export interface Check {
  label: string;
  pass: boolean;
  detail: string;
  requiresReal: boolean;
}

/** Inputs a case's assert() may use beyond the headline Stats. */
export interface CaseContext {
  policy: EnvoyLbPolicyKind;
  config: SimConfig;
  lbLabel: LbLabel;
  lbModule: LbModule;
  events: readonly RequestEvent[];
}

/** One validation case: a scenario plus the expectations it asserts. */
export interface LbValidationCase {
  id: string;
  title: string;
  appliesTo: readonly EnvoyLbPolicyKind[];
  build: (policy: EnvoyLbPolicyKind) => SimConfig;
  assert: (stats: Stats, ctx: CaseContext) => Check[];
}

export const ALL_POLICIES: readonly EnvoyLbPolicyKind[] = [
  'round_robin',
  'least_request',
  'random',
  'ring_hash',
  'maglev',
];
```

- [ ] **Step 4: Write cases/scenario.ts**

`packages/cli/src/cases/scenario.ts`:

```ts
import { type EnvoyLbPolicyKind, type SimConfig, SimConfig as SimConfigSchema } from '@elbsim/config';

export interface ScenarioOpts {
  backends?: number;
  durationMs?: number;
  ratePerSec?: number;
  /** Sparse per-backend overrides keyed by stringified index. */
  overrides?: Record<string, unknown>;
}

/**
 * A compact, deterministic scenario for validation: a couple of Envoys under
 * steady Poisson load to a homogeneous backend pool, with the policy under test.
 * Short by design so the full suite runs fast. Parsed through the schema so all
 * nested defaults (CommonLbConfig, policy params) are materialized.
 */
export function scenario(policy: EnvoyLbPolicyKind, opts: ScenarioOpts = {}): SimConfig {
  return SimConfigSchema.parse({
    version: 1,
    seed: 1,
    time: { durationMs: opts.durationMs ?? 5_000, sampleIntervalMs: 50 },
    clients: {
      count: 20,
      arrival: { kind: 'poisson', ratePerSec: opts.ratePerSec ?? 50 },
      requestKey: { kind: 'zipf', n: 1_000, s: 1.1 },
      lb: { kind: 'round_robin' },
    },
    network: {
      clientToEnvoy: { kind: 'normal', mean: 2, stddev: 0.5 },
      envoyToBackend: { kind: 'normal', mean: 1, stddev: 0.25 },
      crossZonePenaltyMs: 3,
    },
    envoys: {
      count: 2,
      policy: { kind: policy },
      queue: { maxConcurrentRequests: 256, queueCapacity: 1_024 },
    },
    backends: {
      count: opts.backends ?? 6,
      defaults: {
        capacity: 32,
        latency: { kind: 'lognormal', mu: 2.3, sigma: 0.4 },
        queueSize: 64,
      },
      ...(opts.overrides ? { overrides: opts.overrides } : {}),
    },
    timeouts: { requestTimeoutMs: 250, retries: 0 },
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @elbsim/cli test scenario`
Expected: PASS (3 tests).

- [ ] **Step 6: Add `export * from './cases/types';` to `src/index.ts` and commit**

```bash
git add packages/cli/src/cases/types.ts packages/cli/src/cases/scenario.ts packages/cli/src/cases/scenario.test.ts packages/cli/src/index.ts
git commit -m "cli: add validation case types and scenario builder"
```

---

### Task 6: Cross-cutting cases

**Files:**
- Create: `packages/cli/src/cases/cross-cutting.ts`
- Test: `packages/cli/src/cases/cross-cutting.test.ts`

**Interfaces:**
- Consumes: `LbValidationCase`, `Check`, `CaseContext`, `ALL_POLICIES` from `./types`; `scenario` from `./scenario`; `runScenario` from `../driver`; `computeStats`, `Stats` from `../stats`; `SimController` from `@elbsim/sim-core`.
- Produces: `const crossCuttingCases: LbValidationCase[]` with ids `goodput-range`, `lifecycle-conservation`, `determinism`, `stats-aggregation`, `no-unhealthy-traffic`.

- [ ] **Step 1: Write the failing test**

`packages/cli/src/cases/cross-cutting.test.ts`:

```ts
import { mockLbModule } from '@elbsim/sim-core';
import { describe, expect, it } from 'vitest';
import { runScenario } from '../driver';
import { computeStats } from '../stats';
import { crossCuttingCases } from './cross-cutting';
import type { CaseContext } from './types';

function runCase(caseId: string, policy: 'round_robin' = 'round_robin') {
  const c = crossCuttingCases.find((x) => x.id === caseId);
  if (!c) throw new Error(`no case ${caseId}`);
  const config = c.build(policy);
  const { events } = runScenario(config, { module: mockLbModule, label: 'mock' });
  const stats = computeStats(events);
  const ctx: CaseContext = { policy, config, lbLabel: 'mock', lbModule: mockLbModule, events };
  return c.assert(stats, ctx);
}

describe('cross-cutting cases on the mock', () => {
  it('goodput-range passes', () => {
    expect(runCase('goodput-range').every((c) => c.pass)).toBe(true);
  });
  it('lifecycle-conservation passes', () => {
    expect(runCase('lifecycle-conservation').every((c) => c.pass)).toBe(true);
  });
  it('determinism passes', () => {
    expect(runCase('determinism').every((c) => c.pass)).toBe(true);
  });
  it('stats-aggregation passes (queryWindow matches recompute)', () => {
    expect(runCase('stats-aggregation').every((c) => c.pass)).toBe(true);
  });
  it('no-unhealthy-traffic passes (unhealthy host gets no picks)', () => {
    expect(runCase('no-unhealthy-traffic').every((c) => c.pass)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @elbsim/cli test cross-cutting`
Expected: FAIL with unresolved `./cross-cutting`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/cases/cross-cutting.ts`:

```ts
import { SimController } from '@elbsim/sim-core';
import { runScenario } from '../driver';
import { computeStats } from '../stats';
import { scenario } from './scenario';
import { ALL_POLICIES, type Check, type LbValidationCase } from './types';

/** Build a distribution signature (backend -> picks) for equality comparison. */
function pickSignature(perBackend: Map<number, { picks: number }>): string {
  return [...perBackend.entries()]
    .sort(([a], [b]) => a - b)
    .map(([b, c]) => `${b}:${c.picks}`)
    .join(',');
}

export const crossCuttingCases: LbValidationCase[] = [
  {
    id: 'goodput-range',
    title: 'Goodput is a fraction in [0,1] over a non-empty run',
    appliesTo: ALL_POLICIES,
    build: (p) => scenario(p),
    assert: (s): Check[] => [
      {
        label: 'goodput in [0,1]',
        pass: s.goodput >= 0 && s.goodput <= 1 && s.outcomes.total > 0,
        detail: `goodput=${s.goodput.toFixed(4)} total=${s.outcomes.total}`,
        requiresReal: false,
      },
    ],
  },
  {
    id: 'lifecycle-conservation',
    title: 'Every emitted request reaches exactly one terminal outcome',
    appliesTo: ALL_POLICIES,
    build: (p) => scenario(p),
    assert: (s): Check[] => {
      const { completed, timedOut, rejected, total } = s.outcomes;
      const terminal = completed + timedOut + rejected;
      return [
        {
          label: 'emitted == completed + timed_out + rejected',
          pass: terminal === total,
          detail: `emitted=${total} terminal=${terminal} (c=${completed} t=${timedOut} r=${rejected})`,
          requiresReal: false,
        },
      ];
    },
  },
  {
    id: 'determinism',
    title: 'Identical config and seed yield an identical pick distribution',
    appliesTo: ALL_POLICIES,
    build: (p) => scenario(p),
    assert: (s, ctx): Check[] => {
      const again = runScenario(ctx.config, { module: ctx.lbModule, label: ctx.lbLabel });
      const sig = pickSignature(s.perBackend);
      const sigAgain = pickSignature(computeStats(again.events).perBackend);
      return [
        {
          label: 'rerun pick distribution matches',
          pass: sig === sigAgain,
          detail: sig === sigAgain ? `${s.perBackend.size} backends stable` : `${sig} != ${sigAgain}`,
          requiresReal: false,
        },
      ];
    },
  },
  {
    id: 'stats-aggregation',
    title: 'SimController.queryWindow agrees with the independent recompute',
    appliesTo: ALL_POLICIES,
    build: (p) => scenario(p),
    assert: (s, ctx): Check[] => {
      const checks: Check[] = [];
      const controller = new SimController({ lbModule: ctx.lbModule });
      // queryWindow does its own fully-drained replay; loadConfig is enough.
      void controller.loadConfig(ctx.config);
      const agg = controller.queryWindowSync({ fromMs: 0, toMs: ctx.config.time.durationMs });
      const near = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
      checks.push({
        label: 'goodput matches queryWindow',
        pass: near(agg.goodput, s.goodput),
        detail: `window=${agg.goodput.toFixed(6)} recompute=${s.goodput.toFixed(6)}`,
        requiresReal: false,
      });
      checks.push({
        label: 'p99 latency matches queryWindow',
        pass: near(agg.latencyP99, s.latencyP99),
        detail: `window=${agg.latencyP99.toFixed(4)} recompute=${s.latencyP99.toFixed(4)}`,
        requiresReal: false,
      });
      return checks;
    },
  },
  {
    id: 'no-unhealthy-traffic',
    title: 'An unhealthy backend receives no LB picks',
    appliesTo: ALL_POLICIES,
    build: (p) => scenario(p, { backends: 5, overrides: { '0': { health: 'unhealthy' } } }),
    assert: (s): Check[] => {
      const picks = s.perBackend.get(0)?.picks ?? 0;
      return [
        {
          label: 'backend 0 (unhealthy) has zero picks',
          pass: picks === 0,
          detail: `backend0 picks=${picks}`,
          requiresReal: false,
        },
      ];
    },
  },
];
```

Note on `queryWindowSync`: `SimController.queryWindow` is async. To call it inside a synchronous `assert`, add a synchronous sibling on the controller OR make assert async. Decision: keep `assert` synchronous (simpler runner) and add a thin synchronous `queryWindowSync` to `SimController` that shares the existing implementation. See Step 3b.

- [ ] **Step 3b: Add a synchronous queryWindow to SimController**

Modify `packages/sim-core/src/controller.ts`. Rename the existing private aggregation body into a synchronous method and have the async one delegate, so both the worker boundary (async) and in-process callers (sync) share one implementation.

Find:
```ts
  async queryWindow(q: { fromMs: number; toMs: number }) {
```
Replace the method signature line with a sync core plus an async delegator:
```ts
  async queryWindow(q: { fromMs: number; toMs: number }) {
    return this.queryWindowSync(q);
  }

  /** Synchronous core of {@link queryWindow}, for in-process callers (CLI). */
  queryWindowSync(q: { fromMs: number; toMs: number }) {
```
Leave the entire existing method body (the cohort logic and the `return { ... }`) under `queryWindowSync`, and close it with the existing closing brace. This is a pure refactor: behavior is unchanged and the existing `controller.test.ts` still passes.

- [ ] **Step 3c: Verify the sim-core refactor did not regress**

Run: `pnpm --filter @elbsim/sim-core test`
Expected: PASS (existing controller tests green).

- [ ] **Step 4: Run the cross-cutting tests**

Run: `pnpm --filter @elbsim/cli test cross-cutting`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cases/cross-cutting.ts packages/cli/src/cases/cross-cutting.test.ts packages/sim-core/src/controller.ts
git commit -m "cli: add cross-cutting validation cases; expose sync queryWindow"
```

---

### Task 7: Per-policy cases and the registry

**Files:**
- Create: `packages/cli/src/cases/distribution.ts`
- Create: `packages/cli/src/cases/consistency.ts`
- Create: `packages/cli/src/cases/least-request.ts`
- Create: `packages/cli/src/cases/index.ts`
- Test: `packages/cli/src/cases/policy-cases.test.ts`

**Interfaces:**
- Consumes: `scenario` from `./scenario`; `LbValidationCase`, `Check`, `Stats` from `./types`/`../stats`; `crossCuttingCases` from `./cross-cutting`.
- Produces:
  - `const distributionCases: LbValidationCase[]` (`even-distribution`, `weighted-distribution`, `uniform-random`)
  - `const consistencyCases: LbValidationCase[]` (`key-consistency`)
  - `const leastRequestCases: LbValidationCase[]` (`favors-idle`)
  - `const ALL_CASES: readonly LbValidationCase[]` (registry, exported from `./index`)
  - helper `function shares(perBackend: Map<number, { picks: number }>): Map<number, number>`

- [ ] **Step 1: Write the failing test**

`packages/cli/src/cases/policy-cases.test.ts`:

```ts
import { mockLbModule } from '@elbsim/sim-core';
import { describe, expect, it } from 'vitest';
import { runScenario } from '../driver';
import { computeStats } from '../stats';
import { ALL_CASES } from './index';
import type { CaseContext, LbValidationCase } from './types';

function check(c: LbValidationCase, policy: 'round_robin' | 'random' | 'maglev' | 'least_request') {
  const config = c.build(policy);
  const { events } = runScenario(config, { module: mockLbModule, label: 'mock' });
  const stats = computeStats(events);
  const ctx: CaseContext = { policy, config, lbLabel: 'mock', lbModule: mockLbModule, events };
  return c.assert(stats, ctx);
}

function find(id: string): LbValidationCase {
  const c = ALL_CASES.find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
}

describe('per-policy cases', () => {
  it('registry includes cross-cutting and per-policy cases', () => {
    const ids = ALL_CASES.map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'goodput-range',
        'even-distribution',
        'weighted-distribution',
        'uniform-random',
        'key-consistency',
        'favors-idle',
      ]),
    );
  });

  it('even-distribution passes on mock round_robin', () => {
    expect(check(find('even-distribution'), 'round_robin').every((c) => c.pass)).toBe(true);
  });

  it('uniform-random produces all checks (statistical, may vary)', () => {
    expect(check(find('uniform-random'), 'random').length).toBeGreaterThan(0);
  });

  it('key-consistency passes on mock maglev (modulo is key-stable)', () => {
    expect(check(find('key-consistency'), 'maglev').every((c) => c.pass)).toBe(true);
  });

  it('weighted-distribution is marked requiresReal', () => {
    expect(check(find('weighted-distribution'), 'maglev').every((c) => c.requiresReal)).toBe(true);
  });

  it('favors-idle is marked requiresReal', () => {
    expect(check(find('favors-idle'), 'least_request').every((c) => c.requiresReal)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @elbsim/cli test policy-cases`
Expected: FAIL with unresolved `./index`.

- [ ] **Step 3: Write cases/distribution.ts**

`packages/cli/src/cases/distribution.ts`:

```ts
import { scenario } from './scenario';
import { type Check, type LbValidationCase } from './types';

/** Backend -> fraction of total picks. */
export function shares(perBackend: Map<number, { picks: number }>): Map<number, number> {
  let total = 0;
  for (const c of perBackend.values()) total += c.picks;
  const out = new Map<number, number>();
  if (total === 0) return out;
  for (const [b, c] of perBackend) out.set(b, c.picks / total);
  return out;
}

export const distributionCases: LbValidationCase[] = [
  {
    id: 'even-distribution',
    title: 'Round robin spreads picks evenly across equal-weight healthy hosts',
    appliesTo: ['round_robin'],
    build: (p) => scenario(p, { backends: 6 }),
    assert: (s): Check[] => {
      const sh = shares(s.perBackend);
      const expected = 1 / sh.size;
      let worst = 0;
      for (const frac of sh.values()) worst = Math.max(worst, Math.abs(frac - expected));
      return [
        {
          label: 'each host within 5% of even share',
          pass: sh.size > 0 && worst < 0.05,
          detail: `hosts=${sh.size} worst dev=${(worst * 100).toFixed(2)}%`,
          requiresReal: false,
        },
      ];
    },
  },
  {
    id: 'weighted-distribution',
    title: 'Pick share tracks host weight',
    appliesTo: ['round_robin', 'least_request', 'ring_hash', 'maglev'],
    build: (p) => scenario(p, { backends: 4, overrides: { '0': { weight: 4 }, '1': { weight: 2 } } }),
    assert: (s): Check[] => {
      // weights: b0=4, b1=2, b2=1, b3=1 -> total 8
      const weights = new Map<number, number>([
        [0, 4 / 8],
        [1, 2 / 8],
        [2, 1 / 8],
        [3, 1 / 8],
      ]);
      const sh = shares(s.perBackend);
      let worst = 0;
      for (const [b, w] of weights) worst = Math.max(worst, Math.abs((sh.get(b) ?? 0) - w));
      return [
        {
          label: 'weighted share within 5%',
          pass: worst < 0.05,
          detail: `worst dev=${(worst * 100).toFixed(2)}%`,
          requiresReal: true,
        },
      ];
    },
  },
  {
    id: 'uniform-random',
    title: 'Random spreads picks approximately uniformly',
    appliesTo: ['random'],
    build: (p) => scenario(p, { backends: 5, durationMs: 8_000 }),
    assert: (s): Check[] => {
      const sh = shares(s.perBackend);
      const expected = 1 / sh.size;
      let worst = 0;
      for (const frac of sh.values()) worst = Math.max(worst, Math.abs(frac - expected));
      return [
        {
          label: 'each host within 8% of uniform share',
          pass: sh.size > 0 && worst < 0.08,
          detail: `hosts=${sh.size} worst dev=${(worst * 100).toFixed(2)}%`,
          requiresReal: false,
        },
      ];
    },
  },
];
```

- [ ] **Step 4: Write cases/consistency.ts**

`packages/cli/src/cases/consistency.ts`:

```ts
import { scenario } from './scenario';
import { type Check, type LbValidationCase } from './types';

export const consistencyCases: LbValidationCase[] = [
  {
    id: 'key-consistency',
    title: 'Each request key maps to a single backend for the whole run',
    appliesTo: ['ring_hash', 'maglev'],
    build: (p) => scenario(p, { backends: 6 }),
    assert: (s): Check[] => {
      let multi = 0;
      let worstKey = -1;
      for (const [key, set] of s.keyConsistency) {
        if (set.size > 1) {
          multi++;
          if (worstKey < 0) worstKey = key;
        }
      }
      return [
        {
          label: 'no key routed to more than one backend',
          pass: s.keyConsistency.size > 0 && multi === 0,
          detail:
            multi === 0
              ? `${s.keyConsistency.size} distinct keys, all stable`
              : `${multi} keys split (e.g. key ${worstKey})`,
          requiresReal: false,
        },
      ];
    },
  },
];
```

- [ ] **Step 5: Write cases/least-request.ts**

`packages/cli/src/cases/least-request.ts`:

```ts
import { scenario } from './scenario';
import { shares } from './distribution';
import { type Check, type LbValidationCase } from './types';

export const leastRequestCases: LbValidationCase[] = [
  {
    id: 'favors-idle',
    title: 'Least-request sends less traffic to a slow (high active-count) host',
    appliesTo: ['least_request'],
    build: (p) =>
      // Backend 0 is much slower (lower capacity + higher service latency), so it
      // accrues active requests and least_request should steer away from it.
      scenario(p, {
        backends: 4,
        ratePerSec: 80,
        overrides: { '0': { capacity: 4, latency: { kind: 'lognormal', mu: 3.2, sigma: 0.4 } } },
      }),
    assert: (s): Check[] => {
      const sh = shares(s.perBackend);
      const slow = sh.get(0) ?? 0;
      const others = [1, 2, 3].map((b) => sh.get(b) ?? 0);
      const avgOther = others.reduce((a, b) => a + b, 0) / others.length;
      return [
        {
          label: 'slow host share below the average of the others',
          pass: slow < avgOther,
          detail: `slow=${(slow * 100).toFixed(2)}% avgOther=${(avgOther * 100).toFixed(2)}%`,
          requiresReal: true,
        },
      ];
    },
  },
];
```

- [ ] **Step 6: Write cases/index.ts (registry)**

`packages/cli/src/cases/index.ts`:

```ts
import { consistencyCases } from './consistency';
import { crossCuttingCases } from './cross-cutting';
import { distributionCases } from './distribution';
import { leastRequestCases } from './least-request';
import type { LbValidationCase } from './types';

/** The full validation case library, run by `elbsim validate`. */
export const ALL_CASES: readonly LbValidationCase[] = [
  ...crossCuttingCases,
  ...distributionCases,
  ...consistencyCases,
  ...leastRequestCases,
];

export * from './types';
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @elbsim/cli test policy-cases`
Expected: PASS (6 tests).

Note: `uniform-random` and `favors-idle` are statistical. They are exercised here for structure; their behavioral pass/fail is explored via the CLI, not asserted as a gate (the test only checks they produce checks / carry the right `requiresReal` flag).

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/cases/distribution.ts packages/cli/src/cases/consistency.ts packages/cli/src/cases/least-request.ts packages/cli/src/cases/index.ts packages/cli/src/cases/policy-cases.test.ts
git commit -m "cli: add per-policy distribution, consistency, least-request cases"
```

---

### Task 8: Validation runner

**Files:**
- Create: `packages/cli/src/validate.ts`
- Test: `packages/cli/src/validate.test.ts`

**Interfaces:**
- Consumes: `EnvoyLbPolicyKind` from `@elbsim/config`; `selectLb`, `LbMode`, `SelectDeps` from `./lb-select`; `runScenario` from `./driver`; `computeStats` from `./stats`; `ALL_CASES`, `ALL_POLICIES`, `LbValidationCase`, `Check`, `CaseContext` from `./cases/index`/`./cases/types`; `LbLabel` from `./driver`.
- Produces:
  - `type CheckStatus = 'pass' | 'fail' | 'skip'`
  - `interface CheckResult extends Check { status: CheckStatus }`
  - `interface CaseResult { id: string; title: string; checks: CheckResult[] }`
  - `interface PolicyResult { policy: EnvoyLbPolicyKind; lbLabel: LbLabel; note?: string; cases: CaseResult[] }`
  - `interface ValidationResult { policies: PolicyResult[]; passed: number; failed: number; skipped: number }`
  - `function runValidation(policies: readonly EnvoyLbPolicyKind[], mode: LbMode, deps?: SelectDeps, cases?: readonly LbValidationCase[]): Promise<ValidationResult>`

- [ ] **Step 1: Write the failing test**

`packages/cli/src/validate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ALL_POLICIES } from './cases/types';
import { runValidation } from './validate';

// Force mock everywhere so the suite runs without the Wasm artifact.
const mockMode = 'mock' as const;

describe('runValidation (structural, on the mock)', () => {
  it('produces a well-formed result for all policies', async () => {
    const result = await runValidation(ALL_POLICIES, mockMode);
    expect(result.policies).toHaveLength(ALL_POLICIES.length);
    for (const p of result.policies) {
      expect(p.lbLabel).toBe('mock');
      expect(p.cases.length).toBeGreaterThan(0);
      for (const c of p.cases) {
        for (const chk of c.checks) {
          expect(['pass', 'fail', 'skip']).toContain(chk.status);
        }
      }
    }
    expect(result.passed + result.failed + result.skipped).toBeGreaterThan(0);
  });

  it('marks real-only checks SKIP on the mock', async () => {
    const result = await runValidation(['maglev'], mockMode);
    const statuses = result.policies[0]?.cases.flatMap((c) => c.checks.map((k) => k.status)) ?? [];
    expect(statuses).toContain('skip');
  });

  it('only runs cases that apply to a policy', async () => {
    const result = await runValidation(['random'], mockMode);
    const ids = result.policies[0]?.cases.map((c) => c.id) ?? [];
    expect(ids).toContain('uniform-random');
    expect(ids).not.toContain('key-consistency');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @elbsim/cli test validate`
Expected: FAIL with unresolved `./validate`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/validate.ts`:

```ts
import type { EnvoyLbPolicyKind } from '@elbsim/config';
import { ALL_CASES, type LbValidationCase } from './cases/index';
import type { CaseContext } from './cases/types';
import type { LbLabel } from './driver';
import { runScenario } from './driver';
import { type LbMode, type SelectDeps, selectLb } from './lb-select';
import { type Check, computeStats } from './stats';

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface CheckResult extends Check {
  status: CheckStatus;
}

export interface CaseResult {
  id: string;
  title: string;
  checks: CheckResult[];
}

export interface PolicyResult {
  policy: EnvoyLbPolicyKind;
  lbLabel: LbLabel;
  note?: string;
  cases: CaseResult[];
}

export interface ValidationResult {
  policies: PolicyResult[];
  passed: number;
  failed: number;
  skipped: number;
}

/**
 * Run the case library across the given policies. Real-only checks running on
 * the mock are reported SKIP (they upgrade to live as Track A lifts policies).
 * Behavioral pass/fail is informational here; the CLI is the exploration tool,
 * not a CI gate.
 */
export async function runValidation(
  policies: readonly EnvoyLbPolicyKind[],
  mode: LbMode,
  deps?: SelectDeps,
  cases: readonly LbValidationCase[] = ALL_CASES,
): Promise<ValidationResult> {
  const out: PolicyResult[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const policy of policies) {
    const sel = await selectLb(policy, mode, deps);
    const caseResults: CaseResult[] = [];

    for (const c of cases) {
      if (!c.appliesTo.includes(policy)) continue;
      const config = c.build(policy);
      const { events } = runScenario(config, { module: sel.module, label: sel.label });
      const stats = computeStats(events);
      const ctx: CaseContext = {
        policy,
        config,
        lbLabel: sel.label,
        lbModule: sel.module,
        events,
      };
      const checks = c.assert(stats, ctx).map((chk): CheckResult => {
        if (chk.requiresReal && sel.label === 'mock') {
          skipped++;
          return { ...chk, status: 'skip' };
        }
        if (chk.pass) passed++;
        else failed++;
        return { ...chk, status: chk.pass ? 'pass' : 'fail' };
      });
      caseResults.push({ id: c.id, title: c.title, checks });
    }

    out.push({
      policy,
      lbLabel: sel.label,
      ...(sel.note ? { note: sel.note } : {}),
      cases: caseResults,
    });
  }

  return { policies: out, passed, failed, skipped };
}
```

Note: `Check` is re-exported from `./stats`? No. `Check` lives in `./cases/types`. Fix the import: `import type { Check } from './cases/types';` and `import { computeStats } from './stats';`. Use exactly:
```ts
import { computeStats } from './stats';
import type { Check } from './cases/types';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @elbsim/cli test validate`
Expected: PASS (3 tests).

- [ ] **Step 5: Add `export * from './validate';` to `src/index.ts` and commit**

```bash
git add packages/cli/src/validate.ts packages/cli/src/validate.test.ts packages/cli/src/index.ts
git commit -m "cli: add validation runner over the case library"
```

---

### Task 9: Report formatting

**Files:**
- Create: `packages/cli/src/report.ts`
- Test: `packages/cli/src/report.test.ts`

**Interfaces:**
- Consumes: `ValidationResult`, `PolicyResult` from `./validate`; `Stats` from `./stats`; `EnvoyLbPolicyKind` from `@elbsim/config`; `LbLabel` from `./driver`.
- Produces:
  - `interface RunMeta { policy: EnvoyLbPolicyKind; lbLabel: LbLabel; note?: string }`
  - `function formatValidationReport(result: ValidationResult): string`
  - `function formatRunReport(stats: Stats, meta: RunMeta): string`
  - `function jsonReplacer(_key: string, value: unknown): unknown` (serializes Map/Set for `--json`)

- [ ] **Step 1: Write the failing test**

`packages/cli/src/report.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatRunReport, formatValidationReport, jsonReplacer } from './report';
import type { ValidationResult } from './validate';

const result: ValidationResult = {
  passed: 1,
  failed: 1,
  skipped: 1,
  policies: [
    {
      policy: 'maglev',
      lbLabel: 'real',
      cases: [
        {
          id: 'c1',
          title: 'Case one',
          checks: [
            { label: 'ok check', pass: true, detail: 'd1', requiresReal: false, status: 'pass' },
            { label: 'bad check', pass: false, detail: 'd2', requiresReal: false, status: 'fail' },
            { label: 'real check', pass: false, detail: 'd3', requiresReal: true, status: 'skip' },
          ],
        },
      ],
    },
  ],
};

describe('formatValidationReport', () => {
  it('renders policy header, badges, glyphs and a summary', () => {
    const text = formatValidationReport(result);
    expect(text).toMatch(/maglev/);
    expect(text).toMatch(/REAL/);
    expect(text).toContain('ok check');
    expect(text).toContain('bad check');
    expect(text).toContain('real check');
    expect(text).toMatch(/1 passed/);
    expect(text).toMatch(/1 failed/);
    expect(text).toMatch(/1 skipped/);
  });

  it('shows the fallback note when present', () => {
    const withNote: ValidationResult = {
      ...result,
      policies: [{ ...result.policies[0]!, lbLabel: 'mock', note: 'using mock LB' }],
    };
    expect(formatValidationReport(withNote)).toContain('using mock LB');
  });
});

describe('formatRunReport', () => {
  it('renders a distribution table and aggregates', () => {
    const stats = {
      perBackend: new Map([[0, { picks: 3, completed: 3 }]]),
      perEnvoy: new Map([[0, 3]]),
      outcomes: { completed: 3, timedOut: 0, rejected: 0, total: 3 },
      goodput: 1,
      latencyP50: 10,
      latencyP90: 12,
      latencyP99: 15,
      keyConsistency: new Map(),
    };
    const text = formatRunReport(stats, { policy: 'maglev', lbLabel: 'real' });
    expect(text).toMatch(/goodput/i);
    expect(text).toContain('100.00%');
  });
});

describe('jsonReplacer', () => {
  it('serializes Map and Set', () => {
    const json = JSON.stringify({ m: new Map([[1, 2]]), s: new Set([3]) }, jsonReplacer);
    expect(JSON.parse(json)).toEqual({ m: { '1': 2 }, s: [3] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @elbsim/cli test report`
Expected: FAIL with unresolved `./report`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/report.ts`:

```ts
import type { EnvoyLbPolicyKind } from '@elbsim/config';
import type { LbLabel } from './driver';
import type { Stats } from './stats';
import type { ValidationResult } from './validate';

export interface RunMeta {
  policy: EnvoyLbPolicyKind;
  lbLabel: LbLabel;
  note?: string;
}

const GLYPH: Record<'pass' | 'fail' | 'skip', string> = {
  pass: 'PASS',
  fail: 'FAIL',
  skip: 'SKIP',
};

function badge(label: LbLabel): string {
  return label === 'real' ? '[REAL]' : '[MOCK]';
}

/** Human-readable per-policy validation report. */
export function formatValidationReport(result: ValidationResult): string {
  const lines: string[] = [];
  for (const p of result.policies) {
    lines.push('');
    lines.push(`${p.policy} ${badge(p.lbLabel)}${p.note ? `  (${p.note})` : ''}`);
    for (const c of p.cases) {
      lines.push(`  ${c.title}`);
      for (const chk of c.checks) {
        lines.push(`    ${GLYPH[chk.status]}  ${chk.label}  ${chk.detail}`);
      }
    }
  }
  lines.push('');
  lines.push(`${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped`);
  return lines.join('\n');
}

/** Human-readable single-run stats report (the `run` subcommand). */
export function formatRunReport(stats: Stats, meta: RunMeta): string {
  const lines: string[] = [];
  lines.push(`scenario: ${meta.policy} ${badge(meta.lbLabel)}${meta.note ? `  (${meta.note})` : ''}`);
  lines.push('');
  lines.push('backend  picks  completed');
  const rows = [...stats.perBackend.entries()].sort(([a], [b]) => a - b);
  for (const [b, c] of rows) {
    lines.push(`${String(b).padStart(7)}  ${String(c.picks).padStart(5)}  ${String(c.completed).padStart(9)}`);
  }
  lines.push('');
  lines.push(`requests: ${stats.outcomes.total}  completed: ${stats.outcomes.completed}  timed_out: ${stats.outcomes.timedOut}  rejected: ${stats.outcomes.rejected}`);
  lines.push(`goodput: ${(stats.goodput * 100).toFixed(2)}%`);
  lines.push(`latency p50/p90/p99 (ms): ${stats.latencyP50.toFixed(2)} / ${stats.latencyP90.toFixed(2)} / ${stats.latencyP99.toFixed(2)}`);
  return lines.join('\n');
}

/** JSON.stringify replacer that serializes Map -> object and Set -> array. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  return value;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @elbsim/cli test report`
Expected: PASS.

- [ ] **Step 5: Add `export * from './report';` to `src/index.ts` and commit**

```bash
git add packages/cli/src/report.ts packages/cli/src/report.test.ts packages/cli/src/index.ts
git commit -m "cli: add validation and run report formatting"
```

---

### Task 10: CLI entry, bin wiring, docs, and the gate

**Files:**
- Create: `packages/cli/src/cli.ts`
- Test: `packages/cli/src/cli.test.ts`
- Modify: `packages/cli/src/index.ts` (final barrel, if built incrementally)
- Modify: `docs/STATUS.md` (note the new CLI/validation surface)
- Modify: `Makefile` (optional convenience target; only if the repo's Makefile exists)

**Interfaces:**
- Consumes: everything above; `defaultSimConfig`, `SimConfig` parser, `EnvoyLbPolicyKind` from `@elbsim/config`; `node:fs` for `--config`.
- Produces:
  - `interface Io { out: (s: string) => void; err: (s: string) => void }`
  - `const defaultIo: Io`
  - `function main(argv: readonly string[], io?: Io, deps?: SelectDeps): Promise<number>`

- [ ] **Step 1: Write the failing test**

`packages/cli/src/cli.test.ts`:

```ts
import type { LbModule } from '@elbsim/protocol';
import { mockLbModule } from '@elbsim/sim-core';
import { describe, expect, it } from 'vitest';
import { main } from './cli';
import type { Io } from './cli';

function capture(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, out, err };
}

const deps = { loadReal: async () => mockLbModule as unknown as LbModule };

describe('main', () => {
  it('validate --mock prints a report and returns an exit code', async () => {
    const { io, out } = capture();
    const code = await main(['validate', '--mock', '--policy', 'maglev'], io, deps);
    expect(out.join('\n')).toMatch(/maglev/);
    expect([0, 1]).toContain(code);
  });

  it('validate --json emits parseable JSON', async () => {
    const { io, out } = capture();
    await main(['validate', '--mock', '--policy', 'random', '--json'], io, deps);
    expect(() => JSON.parse(out.join('\n'))).not.toThrow();
  });

  it('run --scenario default prints a stats report', async () => {
    const { io, out } = capture();
    const code = await main(['run', '--scenario', 'default', '--policy', 'maglev', '--mock'], io, deps);
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/goodput/);
  });

  it('run with a bad --config path errors with exit 2', async () => {
    const { io, err } = capture();
    const code = await main(['run', '--config', '/nonexistent.json', '--mock'], io, deps);
    expect(code).toBe(2);
    expect(err.join('\n')).not.toBe('');
  });

  it('unknown command prints usage and returns 2', async () => {
    const { io, err } = capture();
    const code = await main(['frobnicate'], io, deps);
    expect(code).toBe(2);
    expect(err.join('\n')).toMatch(/usage/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @elbsim/cli test cli`
Expected: FAIL with unresolved `./cli`.

- [ ] **Step 3: Write the implementation**

`packages/cli/src/cli.ts`:

```ts
import { readFileSync } from 'node:fs';
import {
  defaultSimConfig,
  type EnvoyLbPolicyKind,
  type SimConfig,
  SimConfig as SimConfigSchema,
} from '@elbsim/config';
import { scenario } from './cases/scenario';
import { ALL_POLICIES } from './cases/types';
import { runScenario } from './driver';
import { type LbMode, type SelectDeps, selectLb } from './lb-select';
import { formatRunReport, formatValidationReport, jsonReplacer } from './report';
import { computeStats } from './stats';
import { runValidation } from './validate';

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

export const defaultIo: Io = {
  out: (s) => console.log(s),
  err: (s) => console.error(s),
};

interface Flags {
  policies: EnvoyLbPolicyKind[];
  json: boolean;
  mode: LbMode;
  config?: string;
  scenario?: string;
}

const USAGE =
  'usage: elbsim <run|validate> [--policy p]... [--mock|--real] [--json] [--config file|--scenario name]';

function isPolicy(s: string): s is EnvoyLbPolicyKind {
  return (ALL_POLICIES as readonly string[]).includes(s);
}

function parseFlags(args: readonly string[]): Flags {
  const policies: EnvoyLbPolicyKind[] = [];
  let json = false;
  let mock = false;
  let real = false;
  let config: string | undefined;
  let scenarioName: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--json':
        json = true;
        break;
      case '--mock':
        mock = true;
        break;
      case '--real':
        real = true;
        break;
      case '--policy': {
        const v = args[++i];
        if (v && isPolicy(v)) policies.push(v);
        break;
      }
      case '--config':
        config = args[++i];
        break;
      case '--scenario':
        scenarioName = args[++i];
        break;
    }
  }
  const mode: LbMode = mock ? 'mock' : real ? 'real' : 'auto';
  return {
    policies,
    json,
    mode,
    ...(config ? { config } : {}),
    ...(scenarioName ? { scenario: scenarioName } : {}),
  };
}

function loadScenario(flags: Flags, policy: EnvoyLbPolicyKind): SimConfig {
  if (flags.config) {
    const raw = readFileSync(flags.config, 'utf8');
    return SimConfigSchema.parse(JSON.parse(raw));
  }
  if (flags.scenario === 'default') return defaultSimConfig();
  return scenario(policy);
}

async function cmdValidate(flags: Flags, io: Io, deps?: SelectDeps): Promise<number> {
  const policies = flags.policies.length ? flags.policies : ALL_POLICIES;
  const result = await runValidation(policies, flags.mode, deps);
  io.out(flags.json ? JSON.stringify(result, jsonReplacer, 2) : formatValidationReport(result));
  return result.failed > 0 ? 1 : 0;
}

async function cmdRun(flags: Flags, io: Io, deps?: SelectDeps): Promise<number> {
  const policy = flags.policies[0] ?? 'maglev';
  let config: SimConfig;
  try {
    config = loadScenario(flags, policy);
  } catch (e) {
    io.err(`failed to load scenario: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const sel = await selectLb(policy, flags.mode, deps);
  const { events } = runScenario(config, { module: sel.module, label: sel.label });
  const stats = computeStats(events);
  const meta = { policy, lbLabel: sel.label, ...(sel.note ? { note: sel.note } : {}) };
  io.out(flags.json ? JSON.stringify({ meta, stats }, jsonReplacer, 2) : formatRunReport(stats, meta));
  return 0;
}

/** CLI entry. Returns the process exit code; never throws for normal usage. */
export async function main(argv: readonly string[], io: Io = defaultIo, deps?: SelectDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  const flags = parseFlags(rest);
  try {
    if (cmd === 'validate') return await cmdValidate(flags, io, deps);
    if (cmd === 'run') return await cmdRun(flags, io, deps);
  } catch (e) {
    io.err(e instanceof Error ? e.message : String(e));
    return 2;
  }
  io.err(USAGE);
  return 2;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @elbsim/cli test cli`
Expected: PASS (5 tests).

- [ ] **Step 5: Finalize the barrel and run the full package gate**

Ensure `packages/cli/src/index.ts` re-exports all public modules:
```ts
export * from './driver';
export * from './stats';
export * from './lb-select';
export * from './validate';
export * from './report';
export * from './cli';
export * from './cases/types';
```

Run:
```bash
pnpm exec biome check --write packages/cli packages/sim-core
pnpm --filter @elbsim/cli typecheck
pnpm --filter @elbsim/cli test:cov
```
Expected: biome clean; typecheck passes; all tests pass and coverage >= 95% on lines/functions/branches/statements. If a branch is uncovered, add a focused unit test for it (do not lower the threshold).

- [ ] **Step 6: Smoke-test the real CLI end to end**

Run:
```bash
pnpm --filter @elbsim/cli exec elbsim validate --mock
pnpm --filter @elbsim/cli exec elbsim run --scenario default --policy maglev --mock
```
Expected: a grouped validation report (with SKIPs for real-only checks on the mock) and a single-run stats table. Exit codes are 0/1.

- [ ] **Step 7: Update STATUS.md**

Add a short note under the appropriate section of `docs/STATUS.md` recording the new surface, for example under "Now" or a new bullet:

```
- A headless Node CLI (`@elbsim/cli`, bin `elbsim`) drives the simulator
  without the frontend: `elbsim run` prints per-backend distribution,
  goodput, and latency for a scenario; `elbsim validate` runs a per-LB
  validation suite (expected distribution, consistency, least-request,
  and cross-cutting goodput/conservation/determinism plus a
  queryWindow-vs-recompute stats-aggregation cross-check). Cases run on
  real Wasm where a policy is lifted (maglev) and the mock otherwise,
  each labeled REAL/MOCK; real-only checks SKIP on the mock and upgrade
  as Track A lands ring_hash and the EDF policies. It is an exploration
  tool, not a CI gate.
```

- [ ] **Step 8: Run the whole workspace gate and commit**

Run:
```bash
pnpm run typecheck
pnpm run test
pnpm exec biome ci .
```
Expected: all green across the workspace.

```bash
git add packages/cli docs/STATUS.md
git commit -m "cli: add elbsim CLI entry, docs, and finalize validation suite"
```

---

## Self-review

**Spec coverage:**
- Headless driver -> Task 3. LB selection (auto/mock/real, lifted set, graceful fallback) -> Task 4. Stats recompute -> Task 2. Stats-aggregation cross-check -> Task 6 (`stats-aggregation` case + sync queryWindow). Case library (round_robin even/weighted, least_request, random uniform, ring_hash/maglev consistency, cross-cutting goodput/conservation/determinism/unhealthy) -> Tasks 6-7. REAL/MOCK labeling + requiresReal SKIP -> Tasks 4, 8. CLI `run`/`validate`, flags, `--json` -> Tasks 9-10. Report formatting -> Task 9. Package tests under the gate + structural validate test -> every task + Task 8/10. Minimal-disruption: intentionally left to the existing `wasm-lb/test/maglev.mjs` LB-level golden (noted in spec as real-only and LB-level); not duplicated through the kernel. `inspect` subcommand: out of scope per spec.

**Placeholder scan:** No TBD/TODO; every code step contains complete code. The `src/index.ts` barrel is built incrementally (Task 1 note) and finalized in Task 10 Step 5.

**Type consistency:** `SelectedLb` is declared in `driver.ts` (Task 3) and returned by `selectLb` (Task 4); `LbLabel` flows driver -> lb-select -> cases -> validate -> report consistently. `Check` is defined in `cases/types.ts` and imported there everywhere (validate.ts import corrected in Task 8 Step 3 note). `computeStats`/`Stats` names match across tasks. `queryWindowSync` is added in Task 6 Step 3b and consumed by the `stats-aggregation` case. `runScenario(config, { module, label })` signature is identical in Tasks 3, 6, 7, 8, 10.

**Known statistical caveat:** `uniform-random` and `favors-idle` are statistical; their structural execution is unit-tested but their pass/fail is explored via the CLI, not gated (consistent with the deliverable decision). Tolerances (5%/8%) are starting points; adjust during implementation if a deterministic seed makes them flaky, but never by weakening below a meaningful bound.
