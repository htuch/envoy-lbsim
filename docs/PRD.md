# Envoy LB Simulator: Product Requirements

## Problem

Envoy's load balancing behavior is subtle. The choice of policy (round robin,
least request, random, ring hash, Maglev), its configuration knobs (choice
count, active-request bias, ring sizes, table size, panic threshold, locality
weighting, slow start), the deployment shape (M clients, N Envoy replicas, P
backends), and the live state of the fleet (backend health, capacity, latency,
locality) interact in ways that are hard to reason about from docs or from a
production incident alone. Practitioners lack a safe, fast, faithful way to ask
"what would Envoy actually do here?" and to see why.

## Audience

Technically sophisticated operators of Envoy: SREs, service owners, and
developers who already understand proxies and load balancing and want depth, not
a toy. They will push on edge cases (panic mode, degraded hosts, zone skew,
weighted fairness) and expect the tool to be correct about them.

## Goals

1. Let a user assemble a scenario (clients, Envoys, backends, network, timeouts)
   and run it under open-loop load over virtual time, then explore the result.
2. Be high fidelity about Envoy's LB algorithms specifically: run Envoy's real
   load balancer C++ compiled to WebAssembly, not a re-implementation, so the
   behavior matches Envoy down to the data-structure level.
3. Make the behavior legible: interactive, brushable time-series; a live
   client/Envoy/backend topology; queue and goodput visualizations; and a novel
   inspector that shows an Envoy instance's internal LB data structures (EDF
   heap, Maglev table, hash ring) at a chosen point in virtual time.
4. Track goodput explicitly, with timeouts (measured in virtual time) as a
   first-class component, so the cost of latency and shedding is visible.
5. Run entirely in the browser. No backend, no install; shareable as a static
   site.

## Non-goals

- Not a production traffic generator or a replacement for load testing real
  services. It simulates models of backends, not real ones.
- Not a full Envoy emulator: only the load balancing subsystem is high fidelity.
  HTTP semantics, filters, TLS, xDS, and the connection lifecycle are modeled
  only insofar as they affect LB behavior, and most are abstracted away.
- Not a config authoring/validation tool for production Envoy yaml. The shared
  config is the simulator's own schema, aligned to Envoy's fields but not
  identical to its proto wire format.
- Not multi-service mesh modeling in v1: a single upstream service (one cluster
  of P backends) behind N Envoy replicas.

## Requirements

- Open-loop clients emit requests on fixed statistical schedules (Poisson,
  periodic, uniform) and choose a key per request (uniform or Zipf) to drive
  hash-based balancing. Clients spread load across Envoys by a configurable
  client-side policy (round robin, random, hash, subset, DNS-approximation).
- Virtual time is the substrate: clients, network links, Envoy queues, and
  backends all introduce delays in virtual ms. Timeouts are evaluated in virtual
  time and counted against goodput.
- The Envoy LB policy and its internal state run in Wasm, one instance per Envoy
  replica, driven per request by the kernel.
- Backends have configurable capacity, processing-latency distributions, queue
  sizes, health (healthy/degraded/unhealthy/draining), locality, and weight,
  and these can differ per instance.
- A single in-memory config is the source of truth; the frontend edits it and
  re-runs deterministically (seeded RNG) so results are reproducible.
- Visualization is high signal-to-noise with depth on demand: brushable
  timelines, the topology graph, queue views, analytical charts over a selected
  window, and the LB data-structure inspector.

## Success criteria

- A user can reproduce a known Envoy behavior and see it explained: for example,
  weighted round robin matching configured weights; least-request power-of-two
  draining a hot host; Maglev minimal disruption on host removal; panic mode
  spreading load across all hosts below the threshold.
- The LB outputs match Envoy's real code (validated by compiling Envoy's actual
  LB source to Wasm and checking against reference behavior), not an
  approximation.
- The simulation is deterministic for a fixed seed and config.
- The tool runs smoothly in the browser for realistic fleet sizes with live
  playback and responsive brushing.
