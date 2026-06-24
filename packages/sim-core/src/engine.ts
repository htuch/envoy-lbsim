import type {
  ArrivalProcess,
  BackendHealth,
  BackendSpec,
  ClientLbPolicy,
  SimConfig,
} from '@elbsim/config';
import {
  BACKEND_GAUGES,
  type BackendId,
  CLIENT_GAUGES,
  ENVOY_GAUGES,
  type EntityKind,
  type EnvoyId,
  GaugeRingBuffer,
  gaugeIndex,
  type LbInspection,
  type LbModule,
  type RequestEvent,
  type RequestId,
  type RingBufferSpec,
  type WasmHost,
  type WasmHostSet,
} from '@elbsim/protocol';
import { LatencyHistogram } from './histogram';
import { SimKernel } from './kernel';
import { mockLbModule } from './mock-lb';
import { Prng } from './prng';
import { createKeySampler, sample } from './sampling';

/**
 * The discrete-event simulation engine (Track B). Given a {@link SimConfig} it
 * drives the full request lifecycle deterministically from `seed`:
 *
 *   client emit -> client LB picks an Envoy -> network -> Envoy admission queue
 *   -> Wasm LB picks a backend -> network -> backend service (capacity + queue)
 *   -> response unwinds back to the client (completed / timed_out / rejected).
 *
 * Each transition is recorded as a {@link RequestEvent} (cold path) and every
 * `sampleIntervalMs` of virtual time a frame of per-entity gauges is pushed into
 * the {@link GaugeRingBuffer}s (hot path). The upstream LB runs behind the Wasm
 * ABI; until Track A lands it is the {@link mockLbModule}.
 *
 * The engine runs forward only. Seeking backwards is a fresh engine replayed to
 * the target time (the run is a pure function of the config), which the worker
 * controller does.
 */

const HEALTH_ORDINAL: Record<BackendHealth, number> = {
  healthy: 0,
  degraded: 1,
  unhealthy: 2,
  draining: 3,
};

// The LB host-set health field is 0 unhealthy | 1 degraded | 2 healthy.
const WASM_HEALTH: Record<BackendHealth, 0 | 1 | 2> = {
  healthy: 2,
  degraded: 1,
  unhealthy: 0,
  draining: 0,
};

// Per-tick multiplier applied to each latency histogram so the live percentile
// timeline tracks recent latency rather than the whole run. ~1.4 interval
// half-life: recent completions dominate, but sparse intervals keep a reading.
const LATENCY_DECAY = 0.6;

type SimEvent =
  | { kind: 'arrival'; client: number }
  | { kind: 'reach_envoy'; req: number }
  | { kind: 'reach_backend'; req: number }
  | { kind: 'service_done'; req: number }
  | { kind: 'envoy_return'; req: number }
  | { kind: 'client_return'; req: number }
  | { kind: 'timeout'; req: number }
  | { kind: 'sample' };

interface Req {
  id: RequestId;
  client: number;
  key: number;
  envoy: EnvoyId;
  backend: BackendId; // -1 until the LB picks one
  emitTime: number;
  sentTime: number; // when dispatched upstream (for envoy latency)
  serviceTime: number; // drawn backend service duration
  terminal: boolean; // lifecycle closed (completed / failed)
  upstreamHeld: boolean; // currently occupies an Envoy concurrency slot
}

interface ClientState {
  arrivalRng: Prng;
  keyRng: Prng;
  lbRng: Prng;
  rrCursor: number;
  subset: number[]; // resolved Envoy indices for subset / dns_approx
  inFlight: number;
  emitted: number; // this interval
  completed: number; // this interval
  failed: number; // this interval
}

interface EnvoyState {
  region: string;
  zone: string;
  maxConcurrent: number;
  queueCapacity: number;
  lifo: boolean;
  pending: number[]; // request ids awaiting an admission slot
  activeTotal: number; // outstanding upstream requests (circuit-breaker gauge)
  activeByBackend: number[]; // per-backend outstanding (least_request input)
  picks: number; // this interval
  rejects: number; // this interval
  latency: LatencyHistogram;
}

interface BackendState {
  spec: BackendSpec;
  region: string;
  zone: string;
  rng: Prng;
  serving: number;
  queue: number[]; // request ids awaiting a service slot
  completed: number; // this interval
  shed: number; // this interval
  latency: LatencyHistogram;
}

export interface SimEngineOptions {
  /** LB module to host behind the Wasm ABI; defaults to the TS mock. */
  lbModule?: LbModule;
  /**
   * Ring buffers to write gauge frames into, keyed by entity kind. When the
   * worker controller wants the frames in SharedArrayBuffer-backed memory it
   * pre-allocates them (see {@link ringSpecs}) and injects them here; otherwise
   * the engine allocates plain in-memory buffers.
   */
  channels?: Record<EntityKind, GaugeRingBuffer>;
}

/** The ring-buffer spec per entity kind for a config (full-run capacity). */
export function ringSpecs(config: SimConfig): Record<EntityKind, RingBufferSpec> {
  const capacity = Math.floor(config.time.durationMs / config.time.sampleIntervalMs) + 1;
  return {
    client: { kind: 'client', entityCount: config.clients.count, capacity },
    envoy: { kind: 'envoy', entityCount: config.envoys.count, capacity },
    backend: { kind: 'backend', entityCount: config.backends.count, capacity },
  };
}

export class SimEngine {
  readonly config: SimConfig;
  readonly channels: Record<EntityKind, GaugeRingBuffer>;

  private readonly kernel: SimKernel<SimEvent>;
  private readonly recorded: RequestEvent[] = [];
  private readonly clients: ClientState[] = [];
  private readonly envoys: EnvoyState[] = [];
  private readonly backends: BackendState[] = [];
  private readonly lbs: ReturnType<LbModule['createLb']>[] = [];
  private readonly reqs = new Map<number, Req>();
  private readonly drawKey: (rng: Prng) => number;
  private readonly netRng: Prng;
  private readonly horizon: number;
  private readonly interval: number;
  private nextReqId = 0;

  constructor(config: SimConfig, opts: SimEngineOptions = {}) {
    this.config = config;
    this.horizon = config.time.durationMs;
    this.interval = config.time.sampleIntervalMs;
    const lbModule = opts.lbModule ?? mockLbModule;
    const master = new Prng(config.seed);
    this.netRng = master.fork(6);
    this.drawKey = createKeySampler(config.clients.requestKey);

    const specs = ringSpecs(config);
    this.channels = opts.channels ?? {
      client: GaugeRingBuffer.alloc(specs.client),
      envoy: GaugeRingBuffer.alloc(specs.envoy),
      backend: GaugeRingBuffer.alloc(specs.backend),
    };

    this.initClients(master);
    this.initEnvoys();
    this.initBackends(master);
    this.initLbs(master, lbModule);

    this.kernel = new SimKernel<SimEvent>((event) => this.dispatch(event.payload));
    this.seedInitialEvents();
  }

  /** Recorded cold-path event stream, in virtual-time order. */
  get events(): readonly RequestEvent[] {
    return this.recorded;
  }

  /** Current virtual time (ms). */
  now(): number {
    return this.kernel.now();
  }

  /** Advance virtual time to `tMs`, sampling gauge frames as scheduled. */
  runUntil(tMs: number): void {
    this.kernel.runUntil(tMs);
  }

  /**
   * Run the whole configured horizon and drain the in-flight tail so every
   * emitted request reaches a terminal state. Arrivals and gauge sampling stop
   * at the horizon (no frames are written past it); only the requests already
   * in flight are carried to completion, so this always terminates.
   */
  runToCompletion(): void {
    this.kernel.runUntil(this.horizon);
    this.kernel.runToCompletion();
  }

  /** Serialize an Envoy's LB structures and host view at the current instant. */
  inspect(envoy: EnvoyId): LbInspection {
    const e = this.envoys[envoy];
    const lb = this.lbs[envoy];
    if (!e || !lb) throw new Error(`unknown envoy ${envoy}`);
    const hostSet = this.buildHostSet(envoy);
    lb.updateHosts(hostSet);
    return {
      envoy,
      t: this.now(),
      policy: this.config.envoys.policy.kind,
      panic: this.isPanic(),
      hosts: hostSet.hosts.map((h) => ({ ...h })),
      structure: lb.inspect(),
    };
  }

  // --- setup -------------------------------------------------------------

  private initClients(master: Prng): void {
    const arrivalBase = master.fork(1);
    const keyBase = master.fork(2);
    const lbBase = master.fork(3);
    const envoyCount = this.config.envoys.count;
    for (let c = 0; c < this.config.clients.count; c++) {
      const lbRng = lbBase.fork(c);
      this.clients.push({
        arrivalRng: arrivalBase.fork(c),
        keyRng: keyBase.fork(c),
        lbRng,
        rrCursor: 0,
        subset: resolveSubset(this.config.clients.lb, lbRng, envoyCount),
        inFlight: 0,
        emitted: 0,
        completed: 0,
        failed: 0,
      });
    }
  }

  private initEnvoys(): void {
    const { queue, locality } = this.config.envoys;
    for (let e = 0; e < this.config.envoys.count; e++) {
      this.envoys.push({
        region: locality.region,
        zone: locality.zone,
        maxConcurrent: queue.maxConcurrentRequests,
        queueCapacity: queue.queueCapacity,
        lifo: queue.discipline === 'lifo',
        pending: [],
        activeTotal: 0,
        activeByBackend: new Array(this.config.backends.count).fill(0),
        picks: 0,
        rejects: 0,
        latency: new LatencyHistogram(),
      });
    }
  }

  private initBackends(master: Prng): void {
    const base = master.fork(4);
    const { defaults, overrides } = this.config.backends;
    for (let b = 0; b < this.config.backends.count; b++) {
      const spec = mergeBackendSpec(defaults, overrides[String(b)] ?? {});
      this.backends.push({
        spec,
        region: spec.locality.region,
        zone: spec.locality.zone,
        rng: base.fork(b),
        serving: 0,
        queue: [],
        completed: 0,
        shed: 0,
        latency: new LatencyHistogram(),
      });
    }
  }

  private initLbs(master: Prng, lbModule: LbModule): void {
    const seedBase = master.fork(5);
    const { policy, common } = this.config.envoys;
    for (let e = 0; e < this.config.envoys.count; e++) {
      this.lbs.push(lbModule.createLb(policy, common, seedBase.fork(e).nextInt(2 ** 31)));
    }
  }

  private seedInitialEvents(): void {
    // Stagger first arrivals by a uniform phase so periodic clients don't all
    // fire at once; subsequent arrivals follow the configured process.
    for (let c = 0; c < this.clients.length; c++) {
      const client = this.clients[c] as ClientState;
      const mean = meanInterval(this.config.clients.arrival);
      const phase = client.arrivalRng.nextFloat() * mean;
      if (phase <= this.horizon) this.kernel.scheduleAt(phase, { kind: 'arrival', client: c });
    }
    this.kernel.scheduleAt(0, { kind: 'sample' });
  }

  // --- event dispatch ----------------------------------------------------

  private dispatch(ev: SimEvent): void {
    switch (ev.kind) {
      case 'arrival':
        this.onArrival(ev.client);
        break;
      case 'reach_envoy':
        this.onReachEnvoy(ev.req);
        break;
      case 'reach_backend':
        this.onReachBackend(ev.req);
        break;
      case 'service_done':
        this.onServiceDone(ev.req);
        break;
      case 'envoy_return':
        this.onEnvoyReturn(ev.req);
        break;
      case 'client_return':
        this.onClientReturn(ev.req);
        break;
      case 'timeout':
        this.onTimeout(ev.req);
        break;
      case 'sample':
        this.onSample();
        break;
    }
  }

  private onArrival(c: number): void {
    const client = this.clients[c] as ClientState;
    const t = this.now();

    // Schedule this client's next arrival within the horizon.
    const next = t + nextArrivalDelay(this.config.clients.arrival, client.arrivalRng);
    if (next <= this.horizon) this.kernel.scheduleAt(next, { kind: 'arrival', client: c });

    const key = this.drawKey(client.keyRng);
    const envoy = this.pickEnvoy(client, key);
    const req: Req = {
      id: this.nextReqId++,
      client: c,
      key,
      envoy,
      backend: -1,
      emitTime: t,
      sentTime: 0,
      serviceTime: 0,
      terminal: false,
      upstreamHeld: false,
    };
    this.reqs.set(req.id, req);
    client.emitted++;
    client.inFlight++;
    this.emit({ t, req: req.id, phase: 'emitted', client: c, key });
    this.emit({ t, req: req.id, phase: 'client_routed', client: c, envoy });

    const e = this.envoys[envoy] as EnvoyState;
    const delay = sample(this.config.network.clientToEnvoy, this.netRng) + this.zonePenaltyCE(e);
    this.kernel.scheduleAfter(delay, { kind: 'reach_envoy', req: req.id });
    this.kernel.scheduleAfter(this.config.timeouts.requestTimeoutMs, {
      kind: 'timeout',
      req: req.id,
    });
  }

  private onReachEnvoy(reqId: number): void {
    const req = this.reqs.get(reqId) as Req;
    if (req.terminal) return; // timed out in transit; held no slot yet
    const e = this.envoys[req.envoy] as EnvoyState;
    this.emit({
      t: this.now(),
      req: reqId,
      phase: 'envoy_queued',
      envoy: req.envoy,
      queueDepth: e.pending.length,
    });

    if (e.activeTotal < e.maxConcurrent && e.pending.length === 0) {
      this.dispatchUpstream(req, e);
    } else if (e.pending.length < e.queueCapacity) {
      e.pending.push(reqId);
    } else {
      this.reject(req, 'envoy_overflow', e);
    }
  }

  /** LB pick + send to a backend. Assumes a concurrency slot is available. */
  private dispatchUpstream(req: Req, e: EnvoyState): void {
    const lb = this.lbs[req.envoy] as ReturnType<LbModule['createLb']>;
    lb.updateHosts(this.buildHostSet(req.envoy));
    // Spread the small request key across the full 64-bit hash space before the
    // LB sees it: consistent-hash policies (ring_hash) treat the value as a ring
    // position, so a raw key would collapse all traffic onto one host.
    const backend = lb.chooseHost({
      hashKey: Prng.hash64(req.key),
      region: e.region,
      zone: e.zone,
    });
    if (backend < 0) {
      this.reject(req, 'no_healthy_host', e);
      return;
    }
    req.backend = backend;
    req.sentTime = this.now();
    req.upstreamHeld = true;
    e.activeTotal++;
    e.activeByBackend[backend] = (e.activeByBackend[backend] as number) + 1;
    e.picks++;
    this.emit({
      t: this.now(),
      req: req.id,
      phase: 'lb_pick',
      envoy: req.envoy,
      backend,
      attempts: 1,
    });
    this.emit({ t: this.now(), req: req.id, phase: 'backend_sent', envoy: req.envoy, backend });

    const bk = this.backends[backend] as BackendState;
    const delay =
      sample(this.config.network.envoyToBackend, this.netRng) + this.zonePenaltyEB(e, bk);
    this.kernel.scheduleAfter(delay, { kind: 'reach_backend', req: req.id });
  }

  private onReachBackend(reqId: number): void {
    const req = this.reqs.get(reqId) as Req;
    const bk = this.backends[req.backend] as BackendState;
    if (req.terminal) {
      this.releaseUpstream(req); // timed out in transit while holding a slot
      return;
    }
    if (bk.serving < bk.spec.capacity) {
      this.startService(req, bk);
    } else if (bk.queue.length < bk.spec.queueSize) {
      bk.queue.push(reqId);
    } else {
      this.emit({
        t: this.now(),
        req: reqId,
        phase: 'rejected',
        reason: 'backend_overflow',
        envoy: req.envoy,
        backend: req.backend,
      });
      bk.shed++;
      this.closeFailed(req);
      this.releaseUpstream(req);
    }
  }

  private startService(req: Req, bk: BackendState): void {
    bk.serving++;
    req.serviceTime = sample(bk.spec.latency, bk.rng);
    this.kernel.scheduleAfter(req.serviceTime, { kind: 'service_done', req: req.id });
  }

  private onServiceDone(reqId: number): void {
    const req = this.reqs.get(reqId) as Req;
    const bk = this.backends[req.backend] as BackendState;
    bk.serving--;
    bk.completed++;
    bk.latency.record(req.serviceTime);
    this.pullBackendQueue(bk);
    // Response travels back to the Envoy.
    const e = this.envoys[req.envoy] as EnvoyState;
    const delay =
      sample(this.config.network.envoyToBackend, this.netRng) + this.zonePenaltyEB(e, bk);
    this.kernel.scheduleAfter(delay, { kind: 'envoy_return', req: req.id });
  }

  private pullBackendQueue(bk: BackendState): void {
    while (bk.serving < bk.spec.capacity && bk.queue.length > 0) {
      const nextId = bk.queue.shift() as number;
      const next = this.reqs.get(nextId) as Req;
      if (next.terminal) {
        this.releaseUpstream(next); // drop a timed-out queue entry, free its slot
        continue;
      }
      this.startService(next, bk);
    }
  }

  private onEnvoyReturn(reqId: number): void {
    const req = this.reqs.get(reqId) as Req;
    const e = this.envoys[req.envoy] as EnvoyState;
    this.releaseUpstream(req); // frees the concurrency slot, pulls pending work
    if (req.terminal) return;
    e.latency.record(this.now() - req.sentTime);
    const delay = sample(this.config.network.clientToEnvoy, this.netRng) + this.zonePenaltyCE(e);
    this.kernel.scheduleAfter(delay, { kind: 'client_return', req: req.id });
  }

  private onClientReturn(reqId: number): void {
    const req = this.reqs.get(reqId) as Req;
    if (req.terminal) return;
    req.terminal = true;
    const client = this.clients[req.client] as ClientState;
    client.inFlight--;
    client.completed++;
    this.emit({
      t: this.now(),
      req: reqId,
      phase: 'completed',
      backend: req.backend,
      latencyMs: this.now() - req.emitTime,
    });
    this.reqs.delete(reqId);
  }

  private onTimeout(reqId: number): void {
    const req = this.reqs.get(reqId);
    if (!req || req.terminal) return;
    req.terminal = true;
    const client = this.clients[req.client] as ClientState;
    client.inFlight--;
    client.failed++;
    const envoy = this.envoys[req.envoy] as EnvoyState;
    envoy.rejects++;
    this.emit({
      t: this.now(),
      req: reqId,
      phase: 'timed_out',
      reason: 'timeout',
      envoy: req.envoy,
      ...(req.backend >= 0 ? { backend: req.backend } : {}),
    });
    // Envoy resets the stream on timeout, freeing its slot immediately. A
    // backend already serving keeps its slot until natural service completion.
    if (req.upstreamHeld) this.releaseUpstream(req);
  }

  /** Release an Envoy concurrency slot exactly once and admit pending work. */
  private releaseUpstream(req: Req): void {
    if (!req.upstreamHeld) return;
    req.upstreamHeld = false;
    const e = this.envoys[req.envoy] as EnvoyState;
    e.activeTotal--;
    e.activeByBackend[req.backend] = (e.activeByBackend[req.backend] as number) - 1;
    this.pullPending(e);
  }

  private pullPending(e: EnvoyState): void {
    while (e.activeTotal < e.maxConcurrent && e.pending.length > 0) {
      const id = (e.lifo ? e.pending.pop() : e.pending.shift()) as number;
      const next = this.reqs.get(id) as Req;
      if (next.terminal) continue; // lazily drop timed-out queue entries
      this.dispatchUpstream(next, e);
    }
  }

  private reject(req: Req, reason: 'envoy_overflow' | 'no_healthy_host', e: EnvoyState): void {
    this.emit({ t: this.now(), req: req.id, phase: 'rejected', reason, envoy: req.envoy });
    e.rejects++;
    this.closeFailed(req);
  }

  /** Close a request as a client-visible failure (idempotent on counters). */
  private closeFailed(req: Req): void {
    if (req.terminal) return;
    req.terminal = true;
    const client = this.clients[req.client] as ClientState;
    client.inFlight--;
    client.failed++;
  }

  // --- client-side LB ----------------------------------------------------

  private pickEnvoy(client: ClientState, key: number): EnvoyId {
    const policy = this.config.clients.lb;
    const n = this.config.envoys.count;
    switch (policy.kind) {
      case 'random':
        return client.lbRng.nextInt(n);
      case 'hash':
        // Stable per-key routing: mix the key, then map onto the Envoy set.
        return (Math.imul(key + 1, 2654435761) >>> 0) % n;
      case 'subset':
      case 'dns_approx': {
        const set = client.subset;
        return set[client.rrCursor++ % set.length] as number;
      }
      default: // round_robin
        return client.rrCursor++ % n;
    }
  }

  // --- host set / locality ----------------------------------------------

  private buildHostSet(envoy: EnvoyId): WasmHostSet {
    const e = this.envoys[envoy] as EnvoyState;
    const hosts: WasmHost[] = this.backends.map((bk, b) => ({
      backend: b,
      weight: bk.spec.weight,
      health: WASM_HEALTH[bk.spec.health],
      priority: 0,
      region: bk.region,
      zone: bk.zone,
      activeRequests: e.activeByBackend[b] as number,
    }));
    return { hosts, overprovisioningFactor: this.config.envoys.common.overprovisioningFactor };
  }

  private isPanic(): boolean {
    const total = this.backends.length;
    if (total === 0) return false;
    const healthy = this.backends.filter((b) => b.spec.health === 'healthy').length;
    return (healthy / total) * 100 < this.config.envoys.common.healthyPanicThresholdPercent;
  }

  private zonePenaltyCE(e: EnvoyState): number {
    // Clients share the pool locality; charge the penalty on a zone mismatch.
    return this.config.clients.locality.zone === e.zone
      ? 0
      : this.config.network.crossZonePenaltyMs;
  }

  private zonePenaltyEB(e: EnvoyState, bk: BackendState): number {
    return e.zone === bk.zone ? 0 : this.config.network.crossZonePenaltyMs;
  }

  // --- gauge sampling ----------------------------------------------------

  private onSample(): void {
    const t = this.now();
    this.pushClientFrame(t);
    this.pushEnvoyFrame(t);
    this.pushBackendFrame(t);

    for (const e of this.envoys) e.latency.decay(LATENCY_DECAY);
    for (const bk of this.backends) bk.latency.decay(LATENCY_DECAY);

    const next = t + this.interval;
    if (next <= this.horizon) this.kernel.scheduleAt(next, { kind: 'sample' });
  }

  private pushClientFrame(t: number): void {
    const fields = CLIENT_GAUGES.length;
    const row = new Float32Array(this.clients.length * fields);
    this.clients.forEach((c, i) => {
      const o = i * fields;
      row[o + gaugeIndex('client', 'emitRate')] = c.emitted;
      row[o + gaugeIndex('client', 'inFlight')] = c.inFlight;
      row[o + gaugeIndex('client', 'completed')] = c.completed;
      row[o + gaugeIndex('client', 'failed')] = c.failed;
      c.emitted = 0;
      c.completed = 0;
      c.failed = 0;
    });
    this.channels.client.push(t, row);
  }

  private pushEnvoyFrame(t: number): void {
    const fields = ENVOY_GAUGES.length;
    const healthy = this.backends.filter((b) => b.spec.health === 'healthy').length;
    const panic = this.isPanic() ? 1 : 0;
    const row = new Float32Array(this.envoys.length * fields);
    this.envoys.forEach((e, i) => {
      const o = i * fields;
      row[o + gaugeIndex('envoy', 'inFlight')] = e.activeTotal;
      row[o + gaugeIndex('envoy', 'queueDepth')] = e.pending.length;
      row[o + gaugeIndex('envoy', 'pickRate')] = e.picks;
      row[o + gaugeIndex('envoy', 'rejectRate')] = e.rejects;
      row[o + gaugeIndex('envoy', 'healthyHosts')] = healthy;
      row[o + gaugeIndex('envoy', 'panic')] = panic;
      row[o + gaugeIndex('envoy', 'latencyP50')] = e.latency.quantile(0.5);
      row[o + gaugeIndex('envoy', 'latencyP90')] = e.latency.quantile(0.9);
      row[o + gaugeIndex('envoy', 'latencyP99')] = e.latency.quantile(0.99);
      e.picks = 0;
      e.rejects = 0;
    });
    this.channels.envoy.push(t, row);
  }

  private pushBackendFrame(t: number): void {
    const fields = BACKEND_GAUGES.length;
    const row = new Float32Array(this.backends.length * fields);
    this.backends.forEach((bk, i) => {
      const o = i * fields;
      row[o + gaugeIndex('backend', 'inFlight')] = bk.serving;
      row[o + gaugeIndex('backend', 'queueDepth')] = bk.queue.length;
      row[o + gaugeIndex('backend', 'utilization')] = bk.serving / bk.spec.capacity;
      row[o + gaugeIndex('backend', 'completed')] = bk.completed;
      row[o + gaugeIndex('backend', 'shed')] = bk.shed;
      row[o + gaugeIndex('backend', 'health')] = HEALTH_ORDINAL[bk.spec.health];
      row[o + gaugeIndex('backend', 'latencyP50')] = bk.latency.quantile(0.5);
      row[o + gaugeIndex('backend', 'latencyP90')] = bk.latency.quantile(0.9);
      row[o + gaugeIndex('backend', 'latencyP99')] = bk.latency.quantile(0.99);
      bk.completed = 0;
      bk.shed = 0;
    });
    this.channels.backend.push(t, row);
  }

  private emit(event: RequestEvent): void {
    this.recorded.push(event);
  }
}

// --- pure helpers --------------------------------------------------------

type BackendOverride = SimConfig['backends']['overrides'][string];

function mergeBackendSpec(defaults: BackendSpec, o: BackendOverride): BackendSpec {
  return {
    capacity: o.capacity ?? defaults.capacity,
    latency: o.latency ?? defaults.latency,
    queueSize: o.queueSize ?? defaults.queueSize,
    health: o.health ?? defaults.health,
    weight: o.weight ?? defaults.weight,
    locality: o.locality ?? defaults.locality,
  };
}

function meanInterval(arrival: ArrivalProcess): number {
  return 1000 / arrival.ratePerSec;
}

function nextArrivalDelay(arrival: ArrivalProcess, rng: Prng): number {
  const mean = meanInterval(arrival);
  switch (arrival.kind) {
    case 'poisson':
      return -Math.log(1 - rng.nextFloat()) * mean;
    case 'periodic':
      return mean;
    case 'uniform': {
      const j = arrival.jitterPercent / 100;
      return mean * (1 + (2 * rng.nextFloat() - 1) * j);
    }
  }
}

function resolveSubset(lb: ClientLbPolicy, rng: Prng, envoyCount: number): number[] {
  const size =
    lb.kind === 'subset'
      ? Math.min(lb.subsetSize, envoyCount)
      : lb.kind === 'dns_approx'
        ? Math.min(lb.resolvedSetSize, envoyCount)
        : envoyCount;
  // Deterministic shuffle, take the first `size`.
  const idx = Array.from({ length: envoyCount }, (_, i) => i);
  for (let i = envoyCount - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    [idx[i], idx[j]] = [idx[j] as number, idx[i] as number];
  }
  return idx.slice(0, size);
}
