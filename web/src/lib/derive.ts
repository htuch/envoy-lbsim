import { type EntityKind, type GaugeRingBuffer, gaugeIndex } from '@elbsim/protocol';

/**
 * Fleet-level goodput time series: the fraction of all initiated requests
 * that completed successfully, EWMA-smoothed across frames.
 */
export interface GoodputSeries {
  /** Frame timestamps in seconds (aligned to the client ring's frames). */
  x: number[];
  /** Smoothed goodput in [0,1] per frame. */
  y: number[];
}

/**
 * Per-stage loss time series: fleet sums of each loss kind per frame.
 */
export interface LossSeries {
  /** Frame timestamps in seconds (aligned to the client ring's frames). */
  x: number[];
  /** Fleet sum of client `timedOut` per frame. */
  timeouts: number[];
  /** Fleet sum of envoy `rejectRate` per frame. */
  envoyRejects: number[];
  /** Fleet sum of backend `shed` per frame. */
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
 * Per frame i, raw goodput = completedSum / (completedSum + timedOutSum +
 * envoyRejectSum + backendShedSum). The result is then smoothed with an
 * exponential moving average (alpha defaults to 0.3) and clamped to [0,1].
 *
 * Divide-by-zero (no traffic in a frame) carries the previous smoothed value,
 * or 1 when it is the first frame.
 *
 * The frame count is the shortest of the three rings (they advance together but
 * not atomically under the real worker); the client ring supplies timestamps.
 */
export function goodputSeries(rings: Map<EntityKind, GaugeRingBuffer>, alpha = 0.3): GoodputSeries {
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
  const envoyFieldCount = envoyRing.stride / envoyRing.spec.entityCount;
  const backendFieldCount = backendRing.stride / backendRing.spec.entityCount;

  const clientCount = clientRing.spec.entityCount;
  const envoyCount = envoyRing.spec.entityCount;
  const backendCount = backendRing.spec.entityCount;

  let smoothed = 1;

  for (let i = 0; i < n; i++) {
    const clientFrame = clientRing.frameAt(i);
    const envoyFrame = envoyRing.frameAt(i);
    const backendFrame = backendRing.frameAt(i);

    x[i] = clientFrame.t / 1000;

    let completedSum = 0;
    let timedOutSum = 0;
    for (let e = 0; e < clientCount; e++) {
      completedSum += clientFrame.values[e * clientFieldCount + CLIENT_COMPLETED_IDX] as number;
      timedOutSum += clientFrame.values[e * clientFieldCount + CLIENT_TIMED_OUT_IDX] as number;
    }

    let rejectSum = 0;
    for (let e = 0; e < envoyCount; e++) {
      rejectSum += envoyFrame.values[e * envoyFieldCount + ENVOY_REJECT_RATE_IDX] as number;
    }

    let shedSum = 0;
    for (let e = 0; e < backendCount; e++) {
      shedSum += backendFrame.values[e * backendFieldCount + BACKEND_SHED_IDX] as number;
    }

    const total = completedSum + timedOutSum + rejectSum + shedSum;
    if (total === 0) {
      // No traffic this frame: carry the previous smoothed value (or 1 for the
      // first frame; smoothed is initialised to 1 above).
      y[i] = smoothed;
    } else {
      const raw = completedSum / total;
      smoothed = alpha * raw + (1 - alpha) * smoothed;
      // Clamp to [0,1] as a guardrail against floating-point edge cases.
      smoothed = Math.max(0, Math.min(1, smoothed));
      y[i] = smoothed;
    }
  }

  return { x, y };
}

/**
 * Compute per-stage fleet loss sums per frame.
 *
 * Returns three parallel arrays (timeouts, envoyRejects, backendShed) aligned
 * to the client ring's frame timestamps. The client ring supplies x and
 * frame count.
 */
export function lossSeries(rings: Map<EntityKind, GaugeRingBuffer>): LossSeries {
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

  for (let i = 0; i < n; i++) {
    const clientFrame = clientRing.frameAt(i);
    const envoyFrame = envoyRing.frameAt(i);
    const backendFrame = backendRing.frameAt(i);

    x[i] = clientFrame.t / 1000;

    let timedOutSum = 0;
    for (let e = 0; e < clientCount; e++) {
      timedOutSum += clientFrame.values[e * clientFieldCount + CLIENT_TIMED_OUT_IDX] as number;
    }
    timeouts[i] = timedOutSum;

    let rejectSum = 0;
    for (let e = 0; e < envoyCount; e++) {
      rejectSum += envoyFrame.values[e * envoyFieldCount + ENVOY_REJECT_RATE_IDX] as number;
    }
    envoyRejects[i] = rejectSum;

    let shedSum = 0;
    for (let e = 0; e < backendCount; e++) {
      shedSum += backendFrame.values[e * backendFieldCount + BACKEND_SHED_IDX] as number;
    }
    backendShed[i] = shedSum;
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
