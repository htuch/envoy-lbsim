import { type EntityKind, type GaugeRingBuffer, gaugeIndex } from '@elbsim/protocol';

/**
 * Fleet-level goodput time series: the rate of successfully completed
 * requests per second, EWMA-smoothed across frames.
 */
export interface GoodputSeries {
  /** Frame timestamps in seconds (aligned to the client ring's frames). */
  x: number[];
  /** Smoothed goodput in req/s per frame. */
  y: number[];
}

/**
 * Per-stage loss time series: fleet rates of each loss kind in req/s per frame.
 */
export interface LossSeries {
  /** Frame timestamps in seconds (aligned to the client ring's frames). */
  x: number[];
  /** Fleet timeout rate in req/s per frame. */
  timeouts: number[];
  /** Fleet envoy reject rate in req/s per frame. */
  envoyRejects: number[];
  /** Fleet backend shed rate in req/s per frame. */
  backendShed: number[];
}

/**
 * Single-entity gauge series.
 */
export interface SelectedSeries {
  /** Frame timestamps in seconds. */
  x: number[];
  /** The selected entity's gauge values per frame. */
  y: number[];
}

// Pre-resolve gauge column indices for the three loss gauges. These are
// module-level constants because gaugeIndex() traverses a tuple each call and
// these are always the same columns.
const CLIENT_COMPLETED_IDX = gaugeIndex('client', 'completed');
const CLIENT_TIMED_OUT_IDX = gaugeIndex('client', 'timedOut');
const ENVOY_REJECT_RATE_IDX = gaugeIndex('envoy', 'rejectRate');
const BACKEND_SHED_IDX = gaugeIndex('backend', 'shed');

/**
 * Compute fleet-level goodput from the three ring buffers, EWMA-smoothed.
 *
 * Per frame i, raw goodput rate = completedSum * (1000 / sampleIntervalMs).
 * The result is then smoothed with an exponential moving average (alpha
 * defaults to 0.3). The smoothed value is non-negative (guardrail against
 * floating-point edge cases).
 *
 * Divide-by-zero (no traffic in a frame) carries the previous smoothed value,
 * or 0 when it is the first frame.
 *
 * The frame count is the shortest of the three rings (they advance together but
 * not atomically under the real worker); the client ring supplies timestamps.
 */
export function goodputSeries(
  rings: Map<EntityKind, GaugeRingBuffer>,
  alpha = 0.3,
  sampleIntervalMs = 1000,
): GoodputSeries {
  const clientRing = rings.get('client');
  const envoyRing = rings.get('envoy');
  const backendRing = rings.get('backend');
  if (!clientRing || !envoyRing || !backendRing) {
    return { x: [], y: [] };
  }

  // Bound by the shortest ring. The worker writes the three channels within one
  // virtual tick but not atomically, so a reader can observe them transiently
  // out of sync (e.g. the client frame already pushed, the backend frame not
  // yet). Reading only the frames all three share keeps frameAt in range.
  const n = Math.min(clientRing.size(), envoyRing.size(), backendRing.size());
  const x = new Array<number>(n);
  const y = new Array<number>(n);

  const clientFieldCount = clientRing.stride / clientRing.spec.entityCount;
  const clientCount = clientRing.spec.entityCount;

  const toPerSecond = 1000 / sampleIntervalMs;
  let smoothed = 0;

  for (let i = 0; i < n; i++) {
    const clientFrame = clientRing.frameAt(i);

    x[i] = clientFrame.t / 1000;

    let completedSum = 0;
    for (let e = 0; e < clientCount; e++) {
      completedSum += clientFrame.values[e * clientFieldCount + CLIENT_COMPLETED_IDX] as number;
    }

    if (completedSum === 0 && i > 0) {
      // No completions this frame: carry the previous smoothed value.
      y[i] = smoothed;
    } else {
      const raw = completedSum * toPerSecond;
      smoothed = alpha * raw + (1 - alpha) * smoothed;
      // Non-negative guardrail against floating-point edge cases.
      smoothed = Math.max(0, smoothed);
      y[i] = smoothed;
    }
  }

  return { x, y };
}

/**
 * Compute per-stage fleet loss rates per frame, in req/s.
 *
 * Returns three parallel arrays (timeouts, envoyRejects, backendShed) aligned
 * to the client ring's frame timestamps. Each value is the per-interval fleet
 * sum scaled to per-second by multiplying by (1000 / sampleIntervalMs). The
 * client ring supplies x and frame count.
 */
export function lossSeries(
  rings: Map<EntityKind, GaugeRingBuffer>,
  sampleIntervalMs = 1000,
): LossSeries {
  const clientRing = rings.get('client');
  const envoyRing = rings.get('envoy');
  const backendRing = rings.get('backend');
  if (!clientRing || !envoyRing || !backendRing) {
    return { x: [], timeouts: [], envoyRejects: [], backendShed: [] };
  }

  // Bound by the shortest ring; see goodputSeries for why the three channels can
  // be transiently out of sync under the real worker.
  const n = Math.min(clientRing.size(), envoyRing.size(), backendRing.size());
  const x = new Array<number>(n);
  const timeouts = new Array<number>(n);
  const envoyRejects = new Array<number>(n);
  const backendShed = new Array<number>(n);

  const clientFieldCount = clientRing.stride / clientRing.spec.entityCount;
  const envoyFieldCount = envoyRing.stride / envoyRing.spec.entityCount;
  const backendFieldCount = backendRing.stride / backendRing.spec.entityCount;

  const clientCount = clientRing.spec.entityCount;
  const envoyCount = envoyRing.spec.entityCount;
  const backendCount = backendRing.spec.entityCount;

  const toPerSecond = 1000 / sampleIntervalMs;

  for (let i = 0; i < n; i++) {
    const clientFrame = clientRing.frameAt(i);
    const envoyFrame = envoyRing.frameAt(i);
    const backendFrame = backendRing.frameAt(i);

    x[i] = clientFrame.t / 1000;

    let timedOutSum = 0;
    for (let e = 0; e < clientCount; e++) {
      timedOutSum += clientFrame.values[e * clientFieldCount + CLIENT_TIMED_OUT_IDX] as number;
    }
    timeouts[i] = timedOutSum * toPerSecond;

    let rejectSum = 0;
    for (let e = 0; e < envoyCount; e++) {
      rejectSum += envoyFrame.values[e * envoyFieldCount + ENVOY_REJECT_RATE_IDX] as number;
    }
    envoyRejects[i] = rejectSum * toPerSecond;

    let shedSum = 0;
    for (let e = 0; e < backendCount; e++) {
      shedSum += backendFrame.values[e * backendFieldCount + BACKEND_SHED_IDX] as number;
    }
    backendShed[i] = shedSum * toPerSecond;
  }

  return { x, timeouts, envoyRejects, backendShed };
}

/**
 * Extract a single entity's gauge column across all retained frames of a ring.
 *
 * If `entity` is out of range (negative or >= entityCount), returns a zeroed
 * y array aligned to the x axis. This avoids throwing during a stale
 * selection in the UI while the topology changes.
 */
export function selectedSeries(
  ring: GaugeRingBuffer,
  gaugeIdx: number,
  entity: number,
): SelectedSeries {
  const n = ring.size();
  const x = new Array<number>(n);
  const y = new Array<number>(n);
  const entityCount = ring.spec.entityCount;
  const fieldCount = ring.stride / entityCount;
  const inRange = entity >= 0 && entity < entityCount;

  for (let i = 0; i < n; i++) {
    const frame = ring.frameAt(i);
    x[i] = frame.t / 1000;
    y[i] = inRange ? (frame.values[entity * fieldCount + gaugeIdx] as number) : 0;
  }

  return { x, y };
}
