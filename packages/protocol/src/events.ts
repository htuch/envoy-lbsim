import type { BackendId, ClientId, EnvoyId, RequestId } from './ids';

/**
 * The request-lifecycle event stream (cold path). The kernel emits one ordered
 * event per state transition; the analytical views replay a brushed window of
 * these to compute distributions, traces, and goodput breakdowns. Hot-path live
 * gauges use the ring buffers in `snapshots.ts` instead, not this stream.
 *
 * Every event carries the virtual timestamp (ms) and the request id, so the
 * full lifecycle of one request can be reconstructed by filtering on `req`.
 */

export type RequestPhase =
  | 'emitted' // client created the request
  | 'client_routed' // client picked an Envoy replica
  | 'envoy_queued' // request entered an Envoy admission queue
  | 'lb_pick' // Envoy LB chose a backend host
  | 'backend_sent' // request dispatched to the backend
  | 'completed' // backend responded in time
  | 'timed_out' // exceeded the configured timeout
  | 'rejected'; // shed by an Envoy or backend queue (overflow / no host)

/** Why a request did not succeed (set on terminal non-success phases). */
export type FailureReason =
  | 'timeout'
  | 'envoy_overflow'
  | 'backend_overflow'
  | 'no_healthy_host'
  | 'backend_error';

export interface RequestEventBase {
  t: number; // virtual time (ms)
  req: RequestId;
  phase: RequestPhase;
}

export interface EmittedEvent extends RequestEventBase {
  phase: 'emitted';
  client: ClientId;
  /** Resource/shard key (input to hash-based LB). */
  key: number;
}

export interface ClientRoutedEvent extends RequestEventBase {
  phase: 'client_routed';
  client: ClientId;
  envoy: EnvoyId;
}

export interface EnvoyQueuedEvent extends RequestEventBase {
  phase: 'envoy_queued';
  envoy: EnvoyId;
  queueDepth: number;
}

export interface LbPickEvent extends RequestEventBase {
  phase: 'lb_pick';
  envoy: EnvoyId;
  backend: BackendId;
  /** LB host-selection attempt count (retries on shouldSelectAnotherHost). */
  attempts: number;
}

export interface BackendSentEvent extends RequestEventBase {
  phase: 'backend_sent';
  envoy: EnvoyId;
  backend: BackendId;
}

export interface CompletedEvent extends RequestEventBase {
  phase: 'completed';
  backend: BackendId;
  /** End-to-end latency (ms) from emit to completion. */
  latencyMs: number;
}

export interface TerminalFailureEvent extends RequestEventBase {
  phase: 'timed_out' | 'rejected';
  reason: FailureReason;
  /** The entity that shed/failed the request, when applicable. */
  envoy?: EnvoyId;
  backend?: BackendId;
}

export type RequestEvent =
  | EmittedEvent
  | ClientRoutedEvent
  | EnvoyQueuedEvent
  | LbPickEvent
  | BackendSentEvent
  | CompletedEvent
  | TerminalFailureEvent;

/** Terminal phases that close a request's lifecycle. */
export const TERMINAL_PHASES: ReadonlySet<RequestPhase> = new Set([
  'completed',
  'timed_out',
  'rejected',
]);
