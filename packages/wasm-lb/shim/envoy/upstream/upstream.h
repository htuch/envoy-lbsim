#pragma once
// Faithful-minimal shadow of envoy/upstream/upstream.h.
//
// The real header is the full cluster/host-set runtime (ClusterInfo alone has
// ~100 methods and derives from the HTTP filter-chain factory). The lifted LB
// base operates on a small, well-defined slice: the host-set partitioning
// (hosts / healthy / degraded / excluded, per-locality variants), priority,
// overprovisioning, locality weights, and a few host accessors. We declare
// exactly that interface and provide the concrete implementation in src/lb.cpp,
// built from the kernel's resolved WasmHostSet. Phantom host-vector types,
// HostsPerLocality, and the load typedefs come from the real types.h/phantom.h
// (kept unshadowed, they are dependency-free).
#include <functional>
#include <memory>
#include <vector>

#include "absl/container/flat_hash_map.h"
#include "absl/container/node_hash_map.h"
#include "absl/types/optional.h"

#include "envoy/common/callback.h"
#include "envoy/common/pure.h"
#include "envoy/common/time.h"
#include "envoy/config/core/v3/base.pb.h"
#include "envoy/upstream/host_description.h"
#include "envoy/upstream/types.h"

namespace Envoy {
namespace Upstream {

class Host;
using HostSharedPtr = std::shared_ptr<Host>;
using HostConstSharedPtr = std::shared_ptr<const Host>;
using HostVector = std::vector<HostSharedPtr>;
using HealthyHostVector = Phantom<HostVector, Healthy>;
using DegradedHostVector = Phantom<HostVector, Degraded>;
using ExcludedHostVector = Phantom<HostVector, Excluded>;
using HostMap = absl::flat_hash_map<std::string, HostSharedPtr>;
using HostMapConstSharedPtr = std::shared_ptr<const HostMap>;
using HostVectorSharedPtr = std::shared_ptr<HostVector>;
using HostVectorConstSharedPtr = std::shared_ptr<const HostVector>;
using HealthyHostVectorConstSharedPtr = std::shared_ptr<const HealthyHostVector>;
using DegradedHostVectorConstSharedPtr = std::shared_ptr<const DegradedHostVector>;
using ExcludedHostVectorConstSharedPtr = std::shared_ptr<const ExcludedHostVector>;
using HostListPtr = std::unique_ptr<HostVector>;

// Hash/equality for a Locality key (region/zone/sub_zone), as Envoy uses for the
// per-locality weight map.
struct LocalityHash {
  size_t operator()(const envoy::config::core::v3::Locality& l) const {
    return std::hash<std::string>()(l.region()) ^ (std::hash<std::string>()(l.zone()) << 1) ^
           (std::hash<std::string>()(l.sub_zone()) << 2);
  }
};
struct LocalityEqualTo {
  bool operator()(const envoy::config::core::v3::Locality& a,
                  const envoy::config::core::v3::Locality& b) const {
    return a == b;
  }
};
using LocalityWeightsMap =
    absl::node_hash_map<envoy::config::core::v3::Locality, uint32_t, LocalityHash, LocalityEqualTo>;
using PriorityState = std::vector<std::pair<HostListPtr, LocalityWeightsMap>>;

/** Host as the lifted LB sees it. Concrete impl in src/lb.cpp. */
class Host : public HostDescription {
public:
  enum class Health {
    Unhealthy, // 0
    Degraded,  // 1
    Healthy,   // 2
  };

  virtual Health coarseHealth() const PURE;
  virtual uint32_t weight() const PURE;
  virtual void weight(uint32_t new_weight) PURE;
  virtual absl::optional<MonotonicTime> lastHcPassTime() const PURE;
  virtual void setLastHcPassTime(MonotonicTime last_hc_pass_time) PURE;
};

/** Hosts bucketed by locality (zone-aware routing). */
class HostsPerLocality {
public:
  virtual ~HostsPerLocality() = default;
  virtual bool hasLocalLocality() const PURE;
  virtual const std::vector<HostVector>& get() const PURE;
  virtual std::vector<std::shared_ptr<const HostsPerLocality>>
  filter(const std::vector<std::function<bool(const Host&)>>& predicates) const PURE;
};
using HostsPerLocalitySharedPtr = std::shared_ptr<HostsPerLocality>;
using HostsPerLocalityConstSharedPtr = std::shared_ptr<const HostsPerLocality>;

using LocalityWeights = std::vector<uint32_t>;
using LocalityWeightsSharedPtr = std::shared_ptr<LocalityWeights>;
using LocalityWeightsConstSharedPtr = std::shared_ptr<const LocalityWeights>;

/** One priority level's host set. Concrete impl in src/lb.cpp. */
class HostSet {
public:
  virtual ~HostSet() = default;
  virtual const HostVector& hosts() const PURE;
  virtual HostVectorConstSharedPtr hostsPtr() const PURE;
  virtual const HostVector& healthyHosts() const PURE;
  virtual HealthyHostVectorConstSharedPtr healthyHostsPtr() const PURE;
  virtual const HostVector& degradedHosts() const PURE;
  virtual DegradedHostVectorConstSharedPtr degradedHostsPtr() const PURE;
  virtual const HostVector& excludedHosts() const PURE;
  virtual ExcludedHostVectorConstSharedPtr excludedHostsPtr() const PURE;
  virtual const HostsPerLocality& hostsPerLocality() const PURE;
  virtual HostsPerLocalityConstSharedPtr hostsPerLocalityPtr() const PURE;
  virtual const HostsPerLocality& healthyHostsPerLocality() const PURE;
  virtual HostsPerLocalityConstSharedPtr healthyHostsPerLocalityPtr() const PURE;
  virtual const HostsPerLocality& degradedHostsPerLocality() const PURE;
  virtual HostsPerLocalityConstSharedPtr degradedHostsPerLocalityPtr() const PURE;
  virtual const HostsPerLocality& excludedHostsPerLocality() const PURE;
  virtual HostsPerLocalityConstSharedPtr excludedHostsPerLocalityPtr() const PURE;
  virtual LocalityWeightsConstSharedPtr localityWeights() const PURE;
  virtual uint32_t priority() const PURE;
  virtual uint32_t overprovisioningFactor() const PURE;
  virtual bool weightedPriorityHealth() const PURE;
};
using HostSetPtr = std::unique_ptr<HostSet>;

/** The set of host sets across priority levels. Concrete impl in src/lb.cpp. */
class PrioritySet {
public:
  using MemberUpdateCb =
      std::function<void(const HostVector& hosts_added, const HostVector& hosts_removed)>;
  using PriorityUpdateCb = std::function<void(uint32_t priority, const HostVector& hosts_added,
                                              const HostVector& hosts_removed)>;

  virtual ~PrioritySet() = default;
  virtual Common::CallbackHandlePtr addMemberUpdateCb(MemberUpdateCb callback) const PURE;
  virtual Common::CallbackHandlePtr addPriorityUpdateCb(PriorityUpdateCb callback) const PURE;
  virtual const std::vector<HostSetPtr>& hostSetsPerPriority() const PURE;
  virtual HostMapConstSharedPtr crossPriorityHostMap() const PURE;
};

/** Per-cluster traffic stats. Only the active-request count is read (bounded-load
 *  hashing, which our default config does not enable). */
struct ClusterTrafficStats {
  Stats::PrimitiveGauge upstream_rq_active_;
};
using ClusterTrafficStatsPtr = std::shared_ptr<ClusterTrafficStats>;

/** Cluster info, reduced to what the lifted LB reads off a host's cluster. */
class ClusterInfo {
public:
  virtual ~ClusterInfo() = default;
  virtual ClusterTrafficStatsPtr trafficStats() const PURE;
};

/** Cluster LB stats. The lifted base increments these panic/zone-routing
 *  counters; the harness does not surface them, so plain counters suffice. */
struct ClusterLbStats {
  Stats::PrimitiveCounter lb_healthy_panic_;
  Stats::PrimitiveCounter lb_local_cluster_not_ok_;
  Stats::PrimitiveCounter lb_recalculate_zone_structures_;
  Stats::PrimitiveCounter lb_zone_cluster_too_small_;
  Stats::PrimitiveCounter lb_zone_no_capacity_left_;
  Stats::PrimitiveCounter lb_zone_routing_all_directly_;
  Stats::PrimitiveCounter lb_zone_routing_cross_zone_;
  Stats::PrimitiveCounter lb_zone_routing_sampled_;
};

} // namespace Upstream
} // namespace Envoy
