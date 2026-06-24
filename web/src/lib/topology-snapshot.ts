import { resolveBackend, type SimConfig } from '@elbsim/config';
import { type EntityKind, type GaugeRingBuffer, gaugeFields, gaugeIndex } from '@elbsim/protocol';
import { Prng } from '@elbsim/sim-core';
import type { TopologyNodeStatus, TopologySnapshot } from '@/components/topology/types';
import { makeEdges } from '@/lib/topology-edges';

/**
 * Build a live topology snapshot from the latest frame in each gauge ring
 * buffer. Field semantics match those of the synthetic generator in
 * `web/src/synthetic/topology.ts` so the view code is unchanged when switching
 * between synthetic and live data.
 *
 * Empty rings (size 0) or missing rings produce all-zero-but-valid nodes so
 * the topology still renders before any frames arrive.
 */
export function frameToTopologySnapshot(
  config: SimConfig,
  rings: Map<EntityKind, GaugeRingBuffer>,
  seed?: number,
): TopologySnapshot {
  const clientFrame = rings.get('client')?.latest();
  const envoyFrame = rings.get('envoy')?.latest();
  const backendFrame = rings.get('backend')?.latest();

  const t = envoyFrame?.t ?? 0;

  // Per-kind gauge stride (number of gauge columns per entity per frame).
  const clientStride = gaugeFields('client').length;
  const envoyStride = gaugeFields('envoy').length;
  const backendStride = gaugeFields('backend').length;

  // --- Clients ----------------------------------------------------------------

  // Within-bounds TypedArray reads always return a number; the non-null
  // assertions satisfy noUncheckedIndexedAccess without dead branches.
  const clientInFlightCol = gaugeIndex('client', 'inFlight');
  const clients: TopologyNodeStatus[] = [];
  for (let i = 0; i < config.clients.count; i++) {
    const base = i * clientStride;
    const inFlight = clientFrame ? clientFrame.values[base + clientInFlightCol]! : 0;
    clients.push({
      kind: 'client',
      index: i,
      label: `c${i}`,
      inFlight,
      queueDepth: 0,
      queueCapacity: 0,
      utilization: Math.min(1, inFlight / 4),
      health: 0,
      panic: false,
      region: config.clients.locality.region,
      zone: config.clients.locality.zone,
    });
  }

  // --- Envoys -----------------------------------------------------------------

  const envoyInFlightCol = gaugeIndex('envoy', 'inFlight');
  const envoyQueueDepthCol = gaugeIndex('envoy', 'queueDepth');
  const envoyPanicCol = gaugeIndex('envoy', 'panic');
  const maxConcurrent = config.envoys.queue.maxConcurrentRequests;
  const envoyQueueCapacity = config.envoys.queue.queueCapacity;

  const envoys: TopologyNodeStatus[] = [];
  for (let i = 0; i < config.envoys.count; i++) {
    const base = i * envoyStride;
    const inFlight = envoyFrame ? envoyFrame.values[base + envoyInFlightCol]! : 0;
    const queueDepth = envoyFrame ? envoyFrame.values[base + envoyQueueDepthCol]! : 0;
    const panicVal = envoyFrame ? envoyFrame.values[base + envoyPanicCol]! : 0;
    envoys.push({
      kind: 'envoy',
      index: i,
      label: `e${i}`,
      inFlight,
      queueDepth,
      queueCapacity: envoyQueueCapacity,
      utilization: Math.min(1, inFlight / maxConcurrent),
      health: 0,
      panic: panicVal > 0.5,
      region: config.envoys.locality.region,
      zone: config.envoys.locality.zone,
    });
  }

  // --- Backends ---------------------------------------------------------------

  const backendInFlightCol = gaugeIndex('backend', 'inFlight');
  const backendQueueDepthCol = gaugeIndex('backend', 'queueDepth');
  const backendUtilizationCol = gaugeIndex('backend', 'utilization');
  const backendHealthCol = gaugeIndex('backend', 'health');

  const backends: TopologyNodeStatus[] = [];
  for (let i = 0; i < config.backends.count; i++) {
    const spec = resolveBackend(config.backends, i);
    const base = i * backendStride;
    const inFlight = backendFrame ? backendFrame.values[base + backendInFlightCol]! : 0;
    const queueDepth = backendFrame ? backendFrame.values[base + backendQueueDepthCol]! : 0;
    const utilization = backendFrame ? backendFrame.values[base + backendUtilizationCol]! : 0;
    const rawHealth = backendFrame ? backendFrame.values[base + backendHealthCol]! : 0;
    const health = Math.max(0, Math.min(3, Math.round(rawHealth))) as 0 | 1 | 2 | 3;
    backends.push({
      kind: 'backend',
      index: i,
      label: `b${i}`,
      inFlight,
      queueDepth,
      queueCapacity: spec.queueSize,
      utilization,
      health,
      panic: false,
      region: spec.locality.region,
      zone: spec.locality.zone,
    });
  }

  // --- Edges ------------------------------------------------------------------

  const rng = new Prng(seed ?? config.seed);
  const edges = makeEdges(config, rng);

  return { t, clients, envoys, backends, edges };
}
