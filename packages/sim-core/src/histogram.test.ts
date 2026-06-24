import { describe, expect, it } from 'vitest';
import { LatencyHistogram } from './histogram';

describe('LatencyHistogram', () => {
  it('reports zero quantiles when empty', () => {
    const h = new LatencyHistogram();
    expect(h.count).toBe(0);
    expect(h.quantile(0.5)).toBe(0);
    expect(h.quantile(0.99)).toBe(0);
  });

  it('recovers the median of a uniform spread within bucket resolution', () => {
    const h = new LatencyHistogram();
    for (let v = 0; v <= 1000; v++) h.record(v);
    // p50 of 0..1000 is 500; log-scale buckets near 500 are a few percent wide.
    expect(h.quantile(0.5)).toBeGreaterThan(470);
    expect(h.quantile(0.5)).toBeLessThan(530);
  });

  it('separates tail percentiles from the body', () => {
    const h = new LatencyHistogram();
    for (let i = 0; i < 980; i++) h.record(10);
    for (let i = 0; i < 20; i++) h.record(800);
    expect(h.quantile(0.5)).toBeLessThan(20);
    expect(h.quantile(0.99)).toBeGreaterThan(100);
  });

  it('clamps values above the top bucket into the last bucket', () => {
    const h = new LatencyHistogram();
    h.record(1e12);
    expect(h.count).toBe(1);
    expect(Number.isFinite(h.quantile(0.5))).toBe(true);
    expect(h.quantile(0.5)).toBeGreaterThan(0);
  });

  it('treats negative samples as zero', () => {
    const h = new LatencyHistogram();
    h.record(-5);
    expect(h.count).toBe(1);
    expect(h.quantile(0.5)).toBe(0);
  });

  it('resets to empty', () => {
    const h = new LatencyHistogram();
    h.record(42);
    h.reset();
    expect(h.count).toBe(0);
    expect(h.quantile(0.9)).toBe(0);
  });

  it('decays counts toward recency by a factor', () => {
    const h = new LatencyHistogram();
    for (let i = 0; i < 100; i++) h.record(10);
    h.decay(0.5);
    // Decay halves retained weight; counts are tracked as a weighted total.
    expect(h.count).toBeCloseTo(50, 5);
    // A burst of new samples then dominates the decayed history.
    for (let i = 0; i < 100; i++) h.record(500);
    expect(h.quantile(0.5)).toBeGreaterThan(100);
  });
});
