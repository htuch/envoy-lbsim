// Real Envoy LB compiled to Wasm, exposed over the Embind ABI declared in
// @elbsim/protocol (wasm-abi.ts).
//
// This translation unit instantiates Envoy's ACTUAL load balancer end to end:
// the kernel's resolved host set is turned into a real PrioritySet / HostSet, and
// a real MaglevLoadBalancer (the thread-aware wrapper over the unmodified
// source/extensions/load_balancing_policies/{common,maglev}/*.cc) is driven
// through initialize() -> factory()->create() -> chooseHost(). So Envoy's own
// priority selection, panic-mode threshold, healthy/degraded partitioning,
// locality handling, and weight normalization all run for real -- not just the
// Maglev table. The shim/ headers shadow only Envoy's leaf interface headers
// (Host/HostSet/PrioritySet, stats, runtime, the request-hashing HTTP path);
// every algorithm and the base itself is the real source. See docs/ARCHITECTURE.md
// and packages/wasm-lb/shim.
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include <emscripten/bind.h>

#include "source/common/upstream/load_balancer_context_base.h" // REAL
#include "source/extensions/load_balancing_policies/maglev/maglev_lb.h" // REAL

namespace EU = Envoy::Upstream;
namespace ECfg = Envoy::Config;

namespace {

// ---- Concrete leaf implementations the real base operates on ----------------
//
// These build, from the kernel's flat host arrays, the same structures Envoy's
// cluster layer would hand the LB. They implement exactly the interface the
// shim/ headers declare (the slice the lifted base actually calls).

// Deterministic PRNG (SplitMix64) behind Envoy's RandomGenerator interface, so
// panic-mode random host selection is reproducible from the sim seed.
class RandomImpl : public Envoy::Random::RandomGenerator {
public:
  explicit RandomImpl(uint64_t seed) : state_(seed) {}
  uint64_t random() override {
    state_ += 0x9e3779b97f4a7c15ULL;
    uint64_t z = state_;
    z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL;
    z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL;
    return z ^ (z >> 31);
  }
  std::string uuid() override { return "00000000-0000-0000-0000-000000000000"; }

private:
  uint64_t state_;
};

// A leaf stats scope. The harness surfaces no Envoy stats; createScope just hands
// back another inert scope so the maglev "maglev_lb." sub-scope construction runs.
class ScopeImpl : public Envoy::Stats::Scope {
public:
  Envoy::Stats::ScopeSharedPtr createScope(const std::string&) override {
    return std::make_shared<ScopeImpl>();
  }
};

class ClusterInfoImpl : public EU::ClusterInfo {
public:
  EU::ClusterTrafficStatsPtr trafficStats() const override { return stats_; }

private:
  EU::ClusterTrafficStatsPtr stats_{std::make_shared<EU::ClusterTrafficStats>()};
};

class HostImpl : public EU::Host {
public:
  HostImpl(uint32_t backend, uint32_t weight, Health health, const std::string& region,
           const std::string& zone, uint64_t active_requests, const ClusterInfoImpl& cluster)
      : backend_(backend), weight_(weight), health_(health),
        address_(std::make_shared<const Envoy::Network::Address::Instance>(std::to_string(backend))),
        hostname_(std::to_string(backend)), cluster_(cluster) {
    locality_.set_region(region);
    locality_.set_zone(zone);
    stats_.rq_active_.set(active_requests);
  }

  // The id the kernel assigned this backend; how a picked host crosses the ABI.
  uint32_t backend() const { return backend_; }

  // HostDescription
  const std::string& hostname() const override { return hostname_; }
  Envoy::Network::Address::InstanceConstSharedPtr address() const override { return address_; }
  const envoy::config::core::v3::Locality& locality() const override { return locality_; }
  EU::MetadataConstSharedPtr metadata() const override { return nullptr; }
  const EU::ClusterInfo& cluster() const override { return cluster_; }
  EU::HostStats& stats() const override { return stats_; }

  // Host
  Health coarseHealth() const override { return health_; }
  uint32_t weight() const override { return weight_; }
  void weight(uint32_t new_weight) override { weight_ = new_weight; }
  absl::optional<Envoy::MonotonicTime> lastHcPassTime() const override { return absl::nullopt; }
  void setLastHcPassTime(Envoy::MonotonicTime) override {}

private:
  const uint32_t backend_;
  uint32_t weight_;
  const Health health_;
  const Envoy::Network::Address::InstanceConstSharedPtr address_;
  const std::string hostname_;
  envoy::config::core::v3::Locality locality_;
  const EU::ClusterInfo& cluster_;
  mutable EU::HostStats stats_;
};

// One locality bucket list. The harness models a single locality per priority
// (zone-aware routing needs an explicit local zone, which the default config does
// not set), so this holds one entry with all the priority's hosts.
class HostsPerLocalityImpl : public EU::HostsPerLocality {
public:
  explicit HostsPerLocalityImpl(EU::HostVector hosts) {
    if (!hosts.empty()) {
      buckets_.push_back(std::move(hosts));
    }
  }
  bool hasLocalLocality() const override { return false; }
  const std::vector<EU::HostVector>& get() const override { return buckets_; }
  std::vector<std::shared_ptr<const EU::HostsPerLocality>>
  filter(const std::vector<std::function<bool(const EU::Host&)>>&) const override {
    return {std::make_shared<HostsPerLocalityImpl>(*this)};
  }

private:
  std::vector<EU::HostVector> buckets_;
};

EU::HostsPerLocalityConstSharedPtr makePerLocality(const EU::HostVector& hosts) {
  return std::make_shared<HostsPerLocalityImpl>(hosts);
}

// A single priority level's host set, partitioned by health exactly as Envoy's
// membership update would produce it.
class HostSetImpl : public EU::HostSet {
public:
  HostSetImpl(uint32_t priority, uint32_t overprovisioning_factor, EU::HostVector hosts)
      : priority_(priority), overprovisioning_factor_(overprovisioning_factor),
        hosts_(std::make_shared<EU::HostVector>(std::move(hosts))) {
    auto healthy = std::make_shared<EU::HostVector>();
    auto degraded = std::make_shared<EU::HostVector>();
    for (const auto& host : *hosts_) {
      switch (host->coarseHealth()) {
      case EU::Host::Health::Healthy:
        healthy->push_back(host);
        break;
      case EU::Host::Health::Degraded:
        degraded->push_back(host);
        break;
      case EU::Host::Health::Unhealthy:
        break;
      }
    }
    healthy_ = std::make_shared<EU::HealthyHostVector>(*healthy);
    degraded_ = std::make_shared<EU::DegradedHostVector>(*degraded);
    excluded_ = std::make_shared<EU::ExcludedHostVector>();
    hosts_per_locality_ = makePerLocality(*hosts_);
    healthy_per_locality_ = makePerLocality(healthy_->get());
    degraded_per_locality_ = makePerLocality(degraded_->get());
    excluded_per_locality_ = makePerLocality({});
  }

  const EU::HostVector& hosts() const override { return *hosts_; }
  EU::HostVectorConstSharedPtr hostsPtr() const override { return hosts_; }
  const EU::HostVector& healthyHosts() const override { return healthy_->get(); }
  EU::HealthyHostVectorConstSharedPtr healthyHostsPtr() const override { return healthy_; }
  const EU::HostVector& degradedHosts() const override { return degraded_->get(); }
  EU::DegradedHostVectorConstSharedPtr degradedHostsPtr() const override { return degraded_; }
  const EU::HostVector& excludedHosts() const override { return excluded_->get(); }
  EU::ExcludedHostVectorConstSharedPtr excludedHostsPtr() const override { return excluded_; }
  const EU::HostsPerLocality& hostsPerLocality() const override { return *hosts_per_locality_; }
  EU::HostsPerLocalityConstSharedPtr hostsPerLocalityPtr() const override {
    return hosts_per_locality_;
  }
  const EU::HostsPerLocality& healthyHostsPerLocality() const override {
    return *healthy_per_locality_;
  }
  EU::HostsPerLocalityConstSharedPtr healthyHostsPerLocalityPtr() const override {
    return healthy_per_locality_;
  }
  const EU::HostsPerLocality& degradedHostsPerLocality() const override {
    return *degraded_per_locality_;
  }
  EU::HostsPerLocalityConstSharedPtr degradedHostsPerLocalityPtr() const override {
    return degraded_per_locality_;
  }
  const EU::HostsPerLocality& excludedHostsPerLocality() const override {
    return *excluded_per_locality_;
  }
  EU::HostsPerLocalityConstSharedPtr excludedHostsPerLocalityPtr() const override {
    return excluded_per_locality_;
  }
  // No locality weighting in the harness (single locality per priority).
  EU::LocalityWeightsConstSharedPtr localityWeights() const override { return nullptr; }
  uint32_t priority() const override { return priority_; }
  uint32_t overprovisioningFactor() const override { return overprovisioning_factor_; }
  bool weightedPriorityHealth() const override { return false; }

private:
  const uint32_t priority_;
  const uint32_t overprovisioning_factor_;
  EU::HostVectorConstSharedPtr hosts_;
  EU::HealthyHostVectorConstSharedPtr healthy_;
  EU::DegradedHostVectorConstSharedPtr degraded_;
  EU::ExcludedHostVectorConstSharedPtr excluded_;
  EU::HostsPerLocalityConstSharedPtr hosts_per_locality_;
  EU::HostsPerLocalityConstSharedPtr healthy_per_locality_;
  EU::HostsPerLocalityConstSharedPtr degraded_per_locality_;
  EU::HostsPerLocalityConstSharedPtr excluded_per_locality_;
};

// A no-op callback handle; the harness rebuilds the LB on each host-set update
// rather than firing incremental priority callbacks.
class NoopCallbackHandle : public Envoy::Common::CallbackHandle {};

class PrioritySetImpl : public EU::PrioritySet {
public:
  explicit PrioritySetImpl(std::vector<EU::HostSetPtr> host_sets)
      : host_sets_(std::move(host_sets)),
        cross_priority_host_map_(std::make_shared<const EU::HostMap>()) {}

  Envoy::Common::CallbackHandlePtr addMemberUpdateCb(MemberUpdateCb) const override {
    return std::make_unique<NoopCallbackHandle>();
  }
  Envoy::Common::CallbackHandlePtr addPriorityUpdateCb(PriorityUpdateCb) const override {
    return std::make_unique<NoopCallbackHandle>();
  }
  const std::vector<EU::HostSetPtr>& hostSetsPerPriority() const override { return host_sets_; }
  EU::HostMapConstSharedPtr crossPriorityHostMap() const override {
    return cross_priority_host_map_;
  }

private:
  std::vector<EU::HostSetPtr> host_sets_;
  EU::HostMapConstSharedPtr cross_priority_host_map_;
};

// Per-request context: supplies only the precomputed hash; everything else takes
// the LoadBalancerContextBase defaults.
class ContextImpl : public EU::LoadBalancerContextBase {
public:
  explicit ContextImpl(uint64_t hash) : hash_(hash) {}
  absl::optional<uint64_t> computeHashKey() override { return hash_; }

private:
  const uint64_t hash_;
};

// ---- The ABI instance -------------------------------------------------------

class LbInstance {
public:
  virtual ~LbInstance() = default;
  virtual void updateHosts(const std::vector<int>& backends, const std::vector<double>& weights,
                           const std::vector<int>& healths, const std::vector<int>& priorities,
                           const std::vector<std::string>& regions,
                           const std::vector<std::string>& zones) = 0;
  virtual int chooseHost(double hash) = 0;
  virtual emscripten::val inspect() = 0;
};

class MaglevLb : public LbInstance {
public:
  MaglevLb(uint32_t table_size, bool use_hostname, uint32_t healthy_panic_threshold,
           uint32_t overprovisioning_factor, uint32_t seed)
      : healthy_panic_threshold_(healthy_panic_threshold),
        overprovisioning_factor_(overprovisioning_factor), random_(seed) {
    config_.mutable_table_size()->set_value(table_size);
    config_.mutable_consistent_hashing_lb_config()->set_use_hostname_for_hashing(use_hostname);
  }

  void updateHosts(const std::vector<int>& backends, const std::vector<double>& weights,
                   const std::vector<int>& healths, const std::vector<int>& priorities,
                   const std::vector<std::string>& regions,
                   const std::vector<std::string>& zones) override {
    // Group hosts by priority, preserving input order within each level.
    uint32_t max_priority = 0;
    for (int p : priorities) {
      max_priority = std::max(max_priority, static_cast<uint32_t>(p));
    }
    std::vector<EU::HostVector> by_priority(max_priority + 1);
    for (size_t i = 0; i < backends.size(); ++i) {
      const auto health = static_cast<EU::Host::Health>(healths[i]);
      const std::string region = i < regions.size() ? regions[i] : std::string();
      const std::string zone = i < zones.size() ? zones[i] : std::string();
      by_priority[priorities[i]].push_back(std::make_shared<HostImpl>(
          static_cast<uint32_t>(backends[i]), static_cast<uint32_t>(weights[i]), health, region,
          zone, 0, cluster_));
    }
    std::vector<EU::HostSetPtr> host_sets;
    host_sets.reserve(by_priority.size());
    for (uint32_t p = 0; p < by_priority.size(); ++p) {
      host_sets.push_back(
          std::make_unique<HostSetImpl>(p, overprovisioning_factor_, std::move(by_priority[p])));
    }

    // Rebuild the whole LB on the new membership (matches Envoy's refresh, without
    // threading the incremental priority callback through the harness).
    priority_set_ = std::make_unique<PrioritySetImpl>(std::move(host_sets));
    lb_ = std::make_unique<EU::MaglevLoadBalancer>(*priority_set_, stats_, scope_, runtime_, random_,
                                                   healthy_panic_threshold_, config_, nullptr);
    const absl::Status status = lb_->initialize();
    worker_lb_ = status.ok() ? lb_->factory()->create({*priority_set_}) : nullptr;
  }

  int chooseHost(double hash) override {
    if (!worker_lb_) {
      return -1;
    }
    ContextImpl ctx(static_cast<uint64_t>(hash));
    const auto host = EU::LoadBalancer::onlyAllowSynchronousHostSelection(worker_lb_->chooseHost(&ctx));
    return host ? static_cast<int>(static_cast<const HostImpl&>(*host).backend()) : -1;
  }

  emscripten::val inspect() override {
    emscripten::val out = emscripten::val::object();
    out.set("kind", std::string("maglev"));
    const uint32_t table_size = static_cast<uint32_t>(config_.table_size().value());
    out.set("tableSize", static_cast<double>(table_size));
    // Reveal the live table through the public request path: a request hashed to
    // slot s (s < table_size) lands on table[s] (the real LB selects priority 0 of
    // a single all-healthy set deterministically, then the maglev table by hash).
    emscripten::val table = emscripten::val::array();
    for (uint32_t slot = 0; slot < table_size; ++slot) {
      table.call<void>("push", chooseHost(static_cast<double>(slot)));
    }
    out.set("table", table);
    return out;
  }

private:
  const uint32_t healthy_panic_threshold_;
  const uint32_t overprovisioning_factor_;
  EU::ClusterLbStats stats_{};
  ScopeImpl scope_;
  Envoy::Runtime::Loader runtime_;
  RandomImpl random_;
  ClusterInfoImpl cluster_;
  envoy::extensions::load_balancing_policies::maglev::v3::Maglev config_;
  std::unique_ptr<EU::PrioritySet> priority_set_;
  std::unique_ptr<EU::MaglevLoadBalancer> lb_;
  EU::LoadBalancerPtr worker_lb_;
};

MaglevLb* createMaglevLb(uint32_t table_size, bool use_hostname, uint32_t healthy_panic_threshold,
                         uint32_t overprovisioning_factor, uint32_t seed) {
  return new MaglevLb(table_size, use_hostname, healthy_panic_threshold, overprovisioning_factor,
                      seed);
}

} // namespace

EMSCRIPTEN_BINDINGS(elbsim_wasm_lb) {
  emscripten::register_vector<int>("VectorInt");
  emscripten::register_vector<double>("VectorDouble");
  emscripten::register_vector<std::string>("VectorString");

  emscripten::class_<LbInstance>("LbInstance")
      .function("updateHosts", &LbInstance::updateHosts)
      .function("chooseHost", &LbInstance::chooseHost)
      .function("inspect", &LbInstance::inspect);

  emscripten::class_<MaglevLb, emscripten::base<LbInstance>>("MaglevLb");

  emscripten::function("createMaglevLb", &createMaglevLb, emscripten::allow_raw_pointers());
}
