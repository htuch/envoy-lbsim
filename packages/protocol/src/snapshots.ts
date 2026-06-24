import type { EntityKind } from './ids';

/**
 * Hot-path telemetry contract.
 *
 * Every `sampleIntervalMs` of virtual time the kernel writes one *frame* of
 * per-entity gauges into a {@link GaugeRingBuffer}. The buffers are backed by a
 * `SharedArrayBuffer` so the worker writes and the main thread reads the same
 * memory with no per-frame `postMessage`; the render loop reads the visible
 * window directly. The column sets below are the durable schema; appending a
 * gauge is backwards compatible, reordering/removing one is a breaking change.
 *
 * Layout per channel (one channel per entity kind), structure-of-arrays:
 *   control: Int32Array[2]      = [head, count]
 *   time:    Float64Array[cap]  = frame timestamps (virtual ms)
 *   data:    Float32Array[cap * entityCount * fieldCount]  (row-major per frame)
 */

export const CLIENT_GAUGES = ['emitRate', 'inFlight', 'completed', 'failed'] as const;

export const ENVOY_GAUGES = [
  'inFlight', // active upstream requests
  'queueDepth', // pending admission-queue depth
  'pickRate', // LB picks per sample interval
  'rejectRate', // shed requests per sample interval
  'healthyHosts', // backends currently considered healthy
  'panic', // 1 if the priority set is in panic, else 0
  // Appended latency columns (hot-path histogram, see sim-core histogram.ts):
  // upstream round-trip latency this Envoy observed, in ms.
  'latencyP50',
  'latencyP90',
  'latencyP99',
] as const;

export const BACKEND_GAUGES = [
  'inFlight', // active requests being served
  'queueDepth', // pending queue depth
  'utilization', // inFlight / capacity in [0,1]
  'completed', // completions in this sample interval
  'shed', // overflow drops in this sample interval
  'health', // BackendHealth as ordinal (0 healthy .. 3 draining)
  // Appended latency columns (hot-path histogram): backend service time, in ms.
  'latencyP50',
  'latencyP90',
  'latencyP99',
] as const;

export type GaugeName = (
  | typeof CLIENT_GAUGES
  | typeof ENVOY_GAUGES
  | typeof BACKEND_GAUGES
)[number];

const GAUGES: Record<EntityKind, readonly string[]> = {
  client: CLIENT_GAUGES,
  envoy: ENVOY_GAUGES,
  backend: BACKEND_GAUGES,
};

/** The ordered gauge column names for an entity kind. */
export function gaugeFields(kind: EntityKind): readonly string[] {
  return GAUGES[kind];
}

/** Column index of a named gauge within an entity kind's frame row. */
export function gaugeIndex(kind: EntityKind, name: string): number {
  const i = GAUGES[kind].indexOf(name);
  if (i < 0) throw new Error(`unknown ${kind} gauge: ${name}`);
  return i;
}

export interface RingBufferSpec {
  kind: EntityKind;
  /** Number of entities of this kind (M, N, or P). */
  entityCount: number;
  /** Frames retained before wrap-around. */
  capacity: number;
}

/** Float32 elements in a single frame's data row. */
export function frameStride(spec: RingBufferSpec): number {
  return spec.entityCount * GAUGES[spec.kind].length;
}

export interface RingByteLengths {
  control: number;
  time: number;
  data: number;
}

/** Byte sizes of the three backing arrays, for allocating a SharedArrayBuffer. */
export function ringByteLengths(spec: RingBufferSpec): RingByteLengths {
  return {
    control: 2 * Int32Array.BYTES_PER_ELEMENT,
    time: spec.capacity * Float64Array.BYTES_PER_ELEMENT,
    data: spec.capacity * frameStride(spec) * Float32Array.BYTES_PER_ELEMENT,
  };
}

const HEAD = 0;
const COUNT = 1;

/**
 * A fixed-capacity ring of telemetry frames over caller-provided typed arrays
 * (which may be views into a `SharedArrayBuffer`). Single-writer / multi-reader:
 * the kernel calls {@link push}; readers call {@link size}/{@link frameAt}.
 */
export class GaugeRingBuffer {
  readonly spec: RingBufferSpec;
  readonly stride: number;
  private readonly control: Int32Array;
  private readonly time: Float64Array;
  private readonly data: Float32Array;

  constructor(spec: RingBufferSpec, control: Int32Array, time: Float64Array, data: Float32Array) {
    this.spec = spec;
    this.stride = frameStride(spec);
    if (control.length < 2) throw new Error('control array too small');
    if (time.length < spec.capacity) throw new Error('time array too small');
    if (data.length < spec.capacity * this.stride) throw new Error('data array too small');
    this.control = control;
    this.time = time;
    this.data = data;
  }

  /** Allocate a buffer backed by plain (non-shared) memory; handy for tests. */
  static alloc(spec: RingBufferSpec): GaugeRingBuffer {
    return new GaugeRingBuffer(
      spec,
      new Int32Array(2),
      new Float64Array(spec.capacity),
      new Float32Array(spec.capacity * frameStride(spec)),
    );
  }

  // Within-bounds TypedArray reads are always numbers; the non-null assertions
  // satisfy noUncheckedIndexedAccess without introducing dead `?? 0` branches.
  private get head(): number {
    return this.control[HEAD]!;
  }

  /** Number of frames currently retained (<= capacity). */
  size(): number {
    return this.control[COUNT]!;
  }

  /**
   * Append a frame. `values` must hold exactly {@link stride} floats laid out as
   * entity-major rows (entity 0's fields, then entity 1's, ...).
   */
  push(t: number, values: ArrayLike<number>): void {
    if (values.length !== this.stride) {
      throw new Error(`frame must have ${this.stride} values, got ${values.length}`);
    }
    const cap = this.spec.capacity;
    const head = this.head;
    this.time[head] = t;
    this.data.set(values, head * this.stride);
    this.control[HEAD] = (head + 1) % cap;
    this.control[COUNT] = Math.min(this.size() + 1, cap);
  }

  /**
   * Read frame `i` in chronological order (0 = oldest retained). Returns the
   * timestamp and a copy of that frame's data row.
   */
  frameAt(i: number): { t: number; values: Float32Array } {
    const count = this.size();
    if (i < 0 || i >= count) throw new Error(`frame ${i} out of range [0, ${count})`);
    const cap = this.spec.capacity;
    const physical = (this.head - count + i + cap) % cap;
    return {
      t: this.time[physical]!,
      values: this.data.slice(physical * this.stride, (physical + 1) * this.stride),
    };
  }

  /** The most recently pushed frame, or undefined if empty. */
  latest(): { t: number; values: Float32Array } | undefined {
    const count = this.size();
    return count === 0 ? undefined : this.frameAt(count - 1);
  }
}
