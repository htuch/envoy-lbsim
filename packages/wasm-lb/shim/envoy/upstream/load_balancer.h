#pragma once
// Lightweight shim of envoy/upstream/load_balancer.h. The real header drags in
// router, stream_info, transport_socket, and ORCA protos via the full
// LoadBalancerContext; the lifted consistent-hash tables need none of that. We
// keep the one type they actually return -- HostSelectionResponse, brace-built
// as {host} -- plus opaque stand-ins for the cluster types named only in
// (unused-at-runtime) constructor signatures. Priority/health/locality
// selection is the kernel's job (see ARCHITECTURE.md), so PrioritySet and
// ClusterLbStats are inert here.
#include <memory>
#include <string>

#include "envoy/upstream/upstream.h"

namespace Envoy {
namespace Upstream {

// The lifted hash LBs ignore per-request context (the hash is precomputed); the
// type is only named in signatures we do not exercise.
class LoadBalancerContext;

struct HostSelectionResponse {
  HostSelectionResponse(HostConstSharedPtr host) : host(std::move(host)) {}
  HostConstSharedPtr host;
};

// Named only in the constructor of the (compiled-but-never-instantiated)
// thread-aware LB wrapper. The kernel owns priority/health state, so these are
// empty stand-ins purely to satisfy the signatures.
class PrioritySet;
class ClusterLbStats;

} // namespace Upstream
} // namespace Envoy
