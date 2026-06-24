import type { SimConfig } from '@elbsim/config';
import { type EntityKind, frameStride, gaugeFields, type RingBufferSpec } from '@elbsim/protocol';
import { Prng } from '@elbsim/sim-core';

/**
 * Deterministic synthetic telemetry. This is the *scaffold* the frontend drives
 * itself with until Track B's real kernel lands: it stands in behind the same
 * `@elbsim/protocol` gauge contract, so the hot-path render loop, transport, and
 * config editor are built and exercised against realistic-looking signals.
 *
 * Every gauge value is a pure function of `(seed, kind, entity, gauge, t)`: a
 * sum of two seeded harmonics clamped to a config-derived range. Purity is the
 * point. Seeking to any virtual instant reproduces identical frames, matching
 * the determinism the real simulation guarantees, and lets the runner backfill a
 * trailing window on demand.
 */

/** One seeded two-harmonic gauge signal in the unit interval before mapping. */
interface Wave {
  /** Mid-line of the signal in the unit interval before range mapping. */
  base: number;
  amp1: number;
  amp2: number;
  periodMs1: number;
  periodMs2: number;
  phase1: number;
  phase2: number;
}

/** The mapped range a gauge's unit signal is projected onto. */
interface Range {
  lo: number;
  hi: number;
  /** Round to an integer (counts, host tallies, ordinals). */
  integer: boolean;
}

const TWO_PI = Math.PI * 2;

function entityCount(config: SimConfig, kind: EntityKind): number {
  switch (kind) {
    case 'client':
      return config.clients.count;
    case 'envoy':
      return config.envoys.count;
    case 'backend':
      return config.backends.count;
  }
}

/**
 * The plausible range for a named gauge, derived from config where a natural
 * ceiling exists (queue/concurrency limits, host counts) and from sensible
 * constants otherwise. Synthetic, not a model: enough to look honest on screen.
 */
function gaugeRange(config: SimConfig, kind: EntityKind, gauge: string): Range {
  // Latency percentile columns (appended to the envoy and backend schemas) are
  // virtual ms; scale them off the configured request timeout so P50<P90<P99
  // read plausibly under the deadline.
  if (gauge === 'latencyP50' || gauge === 'latencyP90' || gauge === 'latencyP99') {
    const timeout = config.timeouts.requestTimeoutMs;
    const hi =
      gauge === 'latencyP50' ? timeout * 0.25 : gauge === 'latencyP90' ? timeout * 0.6 : timeout;
    return { lo: 0, hi, integer: false };
  }
  if (kind === 'client') {
    const rate = config.clients.arrival.ratePerSec;
    switch (gauge) {
      case 'emitRate':
        return { lo: 0, hi: rate, integer: false };
      case 'inFlight':
        return { lo: 0, hi: Math.max(4, Math.ceil(rate / 4)), integer: true };
      case 'completed':
        return { lo: 0, hi: Math.max(2, Math.ceil(rate / 8)), integer: true };
      default: // failed
        return { lo: 0, hi: Math.max(1, Math.ceil(rate / 40)), integer: true };
    }
  }
  if (kind === 'envoy') {
    const q = config.envoys.queue;
    const backends = config.backends.count;
    switch (gauge) {
      case 'inFlight':
        return { lo: 0, hi: q.maxConcurrentRequests, integer: true };
      case 'queueDepth':
        return { lo: 0, hi: Math.max(1, q.queueCapacity), integer: true };
      case 'pickRate':
        return { lo: 0, hi: Math.max(8, q.maxConcurrentRequests), integer: true };
      case 'rejectRate':
        return { lo: 0, hi: Math.max(2, Math.ceil(q.maxConcurrentRequests / 16)), integer: true };
      case 'healthyHosts':
        return { lo: Math.max(0, backends - 1), hi: backends, integer: true };
      default: // panic
        return { lo: 0, hi: 1, integer: true };
    }
  }
  // backend
  const cap = config.backends.defaults.capacity;
  switch (gauge) {
    case 'inFlight':
      return { lo: 0, hi: cap, integer: true };
    case 'queueDepth':
      return { lo: 0, hi: Math.max(1, config.backends.defaults.queueSize), integer: true };
    case 'utilization':
      return { lo: 0, hi: 1, integer: false };
    case 'completed':
      return { lo: 0, hi: Math.max(2, Math.ceil(cap / 2)), integer: true };
    case 'shed':
      return { lo: 0, hi: Math.max(1, Math.ceil(cap / 16)), integer: true };
    default: // health ordinal (0 healthy .. 3 draining), mostly healthy
      return { lo: 0, hi: 3, integer: true };
  }
}

/** Draw a stable harmonic pair for one (entity, gauge) stream from a forked PRNG. */
function makeWave(rng: Prng): Wave {
  return {
    base: 0.35 + rng.nextFloat() * 0.3, // centered in the lower-middle of the band
    amp1: 0.15 + rng.nextFloat() * 0.25,
    amp2: 0.05 + rng.nextFloat() * 0.12,
    periodMs1: 4_000 + rng.nextFloat() * 12_000,
    periodMs2: 700 + rng.nextFloat() * 2_500,
    phase1: rng.nextFloat() * TWO_PI,
    phase2: rng.nextFloat() * TWO_PI,
  };
}

/** Evaluate a wave at virtual time `t`, clamped to the unit interval. */
function evalWave(w: Wave, t: number): number {
  const v =
    w.base +
    w.amp1 * Math.sin((TWO_PI * t) / w.periodMs1 + w.phase1) +
    w.amp2 * Math.sin((TWO_PI * t) / w.periodMs2 + w.phase2);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function project(unit: number, r: Range): number {
  const v = r.lo + unit * (r.hi - r.lo);
  return r.integer ? Math.round(v) : v;
}

/** The ordered ring-buffer specs for a run, one channel per entity kind. */
export function channelSpecs(config: SimConfig, capacity: number): RingBufferSpec[] {
  return (['client', 'envoy', 'backend'] as const).map((kind) => ({
    kind,
    entityCount: entityCount(config, kind),
    capacity,
  }));
}

/**
 * A deterministic source of gauge frames for one run. Built once from a config +
 * seed; `fillFrame` writes one entity-major frame row for a kind at virtual time
 * `t`, the exact layout {@link RingBufferSpec} / {@link frameStride} expect.
 */
export class SyntheticModel {
  // Keyed `kind:entity:gaugeIndex` -> seeded wave; precomputed so frame fills are
  // allocation-free on the hot loop.
  private readonly waves = new Map<string, Wave>();

  constructor(
    private readonly config: SimConfig,
    seed: number,
  ) {
    const root = new Prng(seed);
    let stream = 0;
    for (const kind of ['client', 'envoy', 'backend'] as const) {
      const fields = gaugeFields(kind);
      const count = entityCount(config, kind);
      for (let e = 0; e < count; e++) {
        for (let g = 0; g < fields.length; g++) {
          this.waves.set(`${kind}:${e}:${g}`, makeWave(root.fork(stream++)));
        }
      }
    }
  }

  /** Float32 length of one frame row for `kind` (entity-major). */
  strideFor(spec: RingBufferSpec): number {
    return frameStride(spec);
  }

  /**
   * Fill `out` with one frame for `kind` at virtual time `t`. `out.length` must
   * equal `entityCount * gaugeFields(kind).length`.
   */
  fillFrame(kind: EntityKind, t: number, out: Float32Array): void {
    const fields = gaugeFields(kind);
    const count = entityCount(this.config, kind);
    const expected = count * fields.length;
    if (out.length !== expected) {
      throw new Error(`frame for ${kind} needs ${expected} values, got ${out.length}`);
    }
    let i = 0;
    for (let e = 0; e < count; e++) {
      for (let g = 0; g < fields.length; g++) {
        // Every (kind, entity, gauge) wave is seeded in the constructor, so the
        // lookup is total; the assertion just satisfies the Map's T | undefined.
        const wave = this.waves.get(`${kind}:${e}:${g}`) as Wave;
        const range = gaugeRange(this.config, kind, fields[g] as string);
        out[i++] = project(evalWave(wave, t), range);
      }
    }
  }
}
