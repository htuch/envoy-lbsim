import { EventQueue, type ScheduledEvent } from './event-queue';

/**
 * The discrete-event kernel skeleton. It owns the virtual clock and drains the
 * {@link EventQueue} in time order, dispatching each event to a handler that may
 * schedule further events (the usual DES pattern). Track B builds the concrete
 * client/network/Envoy/backend event handlers on top of this; the contract here
 *; monotonic virtual time, deterministic tie-breaking, no wall-clock coupling ;
 * is what the rest of the system relies on.
 */

export type EventHandler<T> = (event: ScheduledEvent<T>, kernel: SimKernel<T>) => void;

export class SimKernel<T> {
  private readonly queue = new EventQueue<T>();
  private readonly handler: EventHandler<T>;
  private clock = 0;

  constructor(handler: EventHandler<T>) {
    this.handler = handler;
  }

  /** Current virtual time (ms). */
  now(): number {
    return this.clock;
  }

  /** Schedule an event at absolute virtual time `time` (must be >= now). */
  scheduleAt(time: number, payload: T): void {
    if (time < this.clock)
      throw new Error(`cannot schedule into the past (${time} < ${this.clock})`);
    this.queue.schedule(time, payload);
  }

  /** Schedule an event `delay` ms from now. */
  scheduleAfter(delay: number, payload: T): void {
    if (delay < 0) throw new Error('delay must be non-negative');
    this.queue.schedule(this.clock + delay, payload);
  }

  /** Whether any events remain. */
  hasWork(): boolean {
    return !this.queue.isEmpty();
  }

  /**
   * Drain all events with time <= `until`, advancing the clock as it goes.
   * Returns the number of events dispatched. The clock ends at `until`.
   */
  runUntil(until: number): number {
    let dispatched = 0;
    for (;;) {
      const next = this.queue.peekTime();
      if (next === undefined || next > until) break;
      const event = this.queue.pop() as ScheduledEvent<T>;
      this.clock = event.time;
      this.handler(event, this);
      dispatched++;
    }
    this.clock = Math.max(this.clock, until);
    return dispatched;
  }

  /** Drain every remaining event regardless of time. */
  runToCompletion(): number {
    let dispatched = 0;
    for (;;) {
      const event = this.queue.pop();
      if (event === undefined) break;
      this.clock = event.time;
      this.handler(event, this);
      dispatched++;
    }
    return dispatched;
  }
}
