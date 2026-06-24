/**
 * A fixed log-scale-bucket latency histogram for the hot path. The kernel keeps
 * one per Envoy and backend, calling {@link record} on each completion and
 * reading {@link quantile} when it samples a gauge frame. Recording and
 * quantile lookup are O(1) / O(buckets), memory is fixed, and the estimate is
 * robust on sparse intervals; this is how Envoy itself measures latency.
 *
 * Buckets are geometric with ratio {@link BASE}: bucket 0 is the underflow
 * `[0, 1)` ms, bucket k (k >= 1) covers `[BASE^(k-1), BASE^k)` ms, and anything
 * above the top edge clamps into the last bucket. {@link decay} multiplies the
 * retained weight so recent samples dominate over stale history when the caller
 * wants a recency-weighted live timeline.
 */

const BASE = 1.05;
const LOG_BASE = Math.log(BASE);
// BASE^299 ~ 2.2e6 ms (~36 min) is a generous ceiling for simulated latencies.
const BUCKET_COUNT = 301;
const MAX_INDEX = BUCKET_COUNT - 1;

// Geometric midpoint of each bucket, used as its representative value. Bucket 0
// (the [0,1) underflow) reports 0 so an all-zero sample set yields a 0 quantile.
const REPRESENTATIVE = buildRepresentatives();

function buildRepresentatives(): Float64Array {
  const reps = new Float64Array(BUCKET_COUNT);
  const sqrtBase = Math.sqrt(BASE);
  for (let k = 1; k < BUCKET_COUNT; k++) reps[k] = BASE ** (k - 1) * sqrtBase;
  return reps;
}

export class LatencyHistogram {
  private readonly buckets = new Float64Array(BUCKET_COUNT);
  private total = 0;

  /** Total retained weight (sample count, fractional after {@link decay}). */
  get count(): number {
    return this.total;
  }

  /** Add one observation (ms). Negatives are treated as 0; large values clamp. */
  record(value: number): void {
    const i = bucketOf(value);
    this.buckets[i] = (this.buckets[i] as number) + 1;
    this.total += 1;
  }

  /**
   * Estimate the q-quantile (q in [0,1]) in ms. Returns 0 when empty. The result
   * is the representative value of the bucket where the cumulative weight first
   * reaches `q * count`, so it is accurate to within one bucket width (~5%).
   */
  quantile(q: number): number {
    if (this.total === 0) return 0;
    const target = q * this.total;
    let cumulative = 0;
    for (let i = 0; i < BUCKET_COUNT; i++) {
      cumulative += this.buckets[i] as number;
      if (cumulative >= target) return REPRESENTATIVE[i] as number;
    }
    return REPRESENTATIVE[MAX_INDEX] as number;
  }

  /** Multiply all retained weight by `factor` (in [0,1]) for recency weighting. */
  decay(factor: number): void {
    for (let i = 0; i < BUCKET_COUNT; i++) {
      this.buckets[i] = (this.buckets[i] as number) * factor;
    }
    this.total *= factor;
  }

  /** Drop all retained samples. */
  reset(): void {
    this.buckets.fill(0);
    this.total = 0;
  }
}

function bucketOf(value: number): number {
  if (!(value >= 1)) return 0; // also catches NaN and negatives -> underflow
  const k = Math.floor(Math.log(value) / LOG_BASE) + 1;
  return k < MAX_INDEX ? k : MAX_INDEX;
}
