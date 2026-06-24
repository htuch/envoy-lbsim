/**
 * A binary min-heap priority queue keyed by virtual time, the spine of the
 * discrete-event kernel. Ties are broken by insertion order (a monotonic
 * sequence counter) so equal-time events fire deterministically in the order
 * they were scheduled.
 */

export interface ScheduledEvent<T> {
  /** Virtual time (ms) at which the event fires. */
  time: number;
  payload: T;
}

interface Node<T> {
  time: number;
  seq: number;
  payload: T;
}

export class EventQueue<T> {
  private heap: Node<T>[] = [];
  private seq = 0;

  get size(): number {
    return this.heap.length;
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  /** Time of the next event without removing it, or undefined if empty. */
  peekTime(): number | undefined {
    return this.heap[0]?.time;
  }

  /** Schedule an event to fire at virtual time `time`. */
  schedule(time: number, payload: T): void {
    if (!Number.isFinite(time)) throw new Error('event time must be finite');
    const node: Node<T> = { time, seq: this.seq++, payload };
    this.heap.push(node);
    this.siftUp(this.heap.length - 1);
  }

  /** Remove and return the earliest event, or undefined if empty. */
  pop(): ScheduledEvent<T> | undefined {
    const heap = this.heap;
    const top = heap[0];
    if (top === undefined) return undefined;
    const last = heap.pop() as Node<T>;
    if (heap.length > 0) {
      heap[0] = last;
      this.siftDown(0);
    }
    return { time: top.time, payload: top.payload };
  }

  private less(a: Node<T>, b: Node<T>): boolean {
    return a.time < b.time || (a.time === b.time && a.seq < b.seq);
  }

  private siftUp(i: number): void {
    const heap = this.heap;
    const node = heap[i] as Node<T>;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const p = heap[parent] as Node<T>;
      if (!this.less(node, p)) break;
      heap[i] = p;
      i = parent;
    }
    heap[i] = node;
  }

  private siftDown(i: number): void {
    const heap = this.heap;
    const n = heap.length;
    const node = heap[i] as Node<T>;
    for (;;) {
      const left = 2 * i + 1;
      if (left >= n) break;
      const right = left + 1;
      let child = left;
      if (right < n && this.less(heap[right] as Node<T>, heap[left] as Node<T>)) child = right;
      const c = heap[child] as Node<T>;
      if (!this.less(c, node)) break;
      heap[i] = c;
      i = child;
    }
    heap[i] = node;
  }
}
