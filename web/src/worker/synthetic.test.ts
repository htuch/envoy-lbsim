import { defaultSimConfig } from '@elbsim/config';
import { type EntityKind, frameStride, gaugeFields, gaugeIndex } from '@elbsim/protocol';
import { describe, expect, it } from 'vitest';
import { channelSpecs, SyntheticModel } from './synthetic';

const KINDS: EntityKind[] = ['client', 'envoy', 'backend'];

describe('channelSpecs', () => {
  it('builds one spec per entity kind with the configured counts', () => {
    const config = defaultSimConfig();
    const specs = channelSpecs(config, 100);
    expect(specs.map((s) => s.kind)).toEqual(KINDS);
    expect(specs.map((s) => s.entityCount)).toEqual([
      config.clients.count,
      config.envoys.count,
      config.backends.count,
    ]);
    expect(specs.every((s) => s.capacity === 100)).toBe(true);
  });
});

describe('SyntheticModel', () => {
  it('fills a frame of the exact stride, every value within its gauge band', () => {
    const config = defaultSimConfig();
    const model = new SyntheticModel(config, config.seed);
    for (const spec of channelSpecs(config, 1)) {
      const out = new Float32Array(frameStride(spec));
      model.fillFrame(spec.kind, 1234, out);
      expect(out.length).toBe(spec.entityCount * gaugeFields(spec.kind).length);
      for (const v of out) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('exposes the protocol frame stride', () => {
    const config = defaultSimConfig();
    const model = new SyntheticModel(config, 1);
    const spec = channelSpecs(config, 1)[1]!; // envoy
    expect(model.strideFor(spec)).toBe(frameStride(spec));
  });

  it('is deterministic in (seed, t): same seed reproduces, different seed differs', () => {
    const config = defaultSimConfig();
    const a = new SyntheticModel(config, 7);
    const b = new SyntheticModel(config, 7);
    const c = new SyntheticModel(config, 8);
    const spec = channelSpecs(config, 1)[1]!;
    const fa = new Float32Array(frameStride(spec));
    const fb = new Float32Array(frameStride(spec));
    const fc = new Float32Array(frameStride(spec));
    a.fillFrame('envoy', 500, fa);
    b.fillFrame('envoy', 500, fb);
    c.fillFrame('envoy', 500, fc);
    expect(Array.from(fb)).toEqual(Array.from(fa));
    expect(Array.from(fc)).not.toEqual(Array.from(fa));
  });

  it('reproduces the same frame when revisiting a virtual instant (seek-safe)', () => {
    const config = defaultSimConfig();
    const model = new SyntheticModel(config, 3);
    const spec = channelSpecs(config, 1)[2]!; // backend
    const first = new Float32Array(frameStride(spec));
    const again = new Float32Array(frameStride(spec));
    model.fillFrame('backend', 999, first);
    model.fillFrame('backend', 100, new Float32Array(frameStride(spec))); // move away
    model.fillFrame('backend', 999, again); // and back
    expect(Array.from(again)).toEqual(Array.from(first));
  });

  it('rejects a frame buffer of the wrong size', () => {
    const config = defaultSimConfig();
    const model = new SyntheticModel(config, 1);
    expect(() => model.fillFrame('envoy', 0, new Float32Array(1))).toThrow(/needs/);
  });

  it('derives client gauge bands from the arrival rate (periodic arrival)', () => {
    const config = defaultSimConfig();
    const periodic = {
      ...config,
      clients: { ...config.clients, arrival: { kind: 'periodic' as const, ratePerSec: 40 } },
    };
    const model = new SyntheticModel(periodic, 1);
    const spec = channelSpecs(periodic, 1)[0]!; // client
    const out = new Float32Array(frameStride(spec));
    model.fillFrame('client', 250, out);
    // emitRate is column 0 and bounded by the configured rate.
    expect(out[0]).toBeLessThanOrEqual(40);
  });

  it('writes a finite timedOut value into client frames at gaugeIndex("client","timedOut")', () => {
    const config = defaultSimConfig();
    const model = new SyntheticModel(config, config.seed);
    const spec = channelSpecs(config, 1)[0]!; // client
    const stride = frameStride(spec);
    const fields = gaugeFields('client');
    const timedOutIdx = gaugeIndex('client', 'timedOut');
    // Sample multiple virtual times to confirm the gauge is written and bounded.
    for (const t of [0, 500, 1000, 5000]) {
      const out = new Float32Array(stride);
      model.fillFrame('client', t, out);
      // For each client entity, the timedOut column must be finite.
      for (let e = 0; e < spec.entityCount; e++) {
        const v = out[e * fields.length + timedOutIdx];
        expect(v).toBeDefined();
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
