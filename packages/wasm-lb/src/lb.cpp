// Real Envoy LB compiled to Wasm, exposed over the Embind ABI declared in
// @elbsim/protocol (wasm-abi.ts).
//
// This translation unit instantiates Envoy's ACTUAL load balancers end to end:
// the kernel's resolved host set is turned into a real PrioritySet / HostSet, and
// a real Envoy load balancer (the unmodified
// source/extensions/load_balancing_policies/{common,maglev,ring_hash}/*.cc) is
// driven through its real interface. So Envoy's own priority selection, panic-mode
// threshold, healthy/degraded partitioning, locality handling, and weight
// normalization all run for real -- not just the policy data structure. The shim/
// headers shadow only Envoy's leaf interface headers (Host/HostSet/PrioritySet,
// stats, runtime, the request-hashing HTTP path); every algorithm and the base
// itself is the real source. See docs/ARCHITECTURE.md and packages/wasm-lb/shim.
//
// The consistent-hash policies (maglev, ring_hash) are ThreadAwareLoadBalancers:
// they build an immutable structure on each membership change and resolve a
// const, stateless worker LB per pick (initialize() -> factory()->create() ->
// chooseHost()). The shared driving machinery lives in ThreadAwareLbInstance.
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <memory>
#include <string>
#include <vector>

#include <emscripten/bind.h>

#include "source/common/upstream/load_balancer_context_base.h"                       // REAL
#include "source/extensions/load_balancing_policies/least_request/least_request_lb.h" // REAL
#include "source/extensions/load_balancing_policies/maglev/maglev_lb.h"              // REAL
#include "source/extensions/load_balancing_policies/random/random_lb.h"             // REAL
#include "source/extensions/load_balancing_policies/ring_hash/ring_hash_lb.h"       // REAL
#include "source/extensions/load_balancing_policies/round_robin/round_robin_lb.h"   // REAL

namespace EU = Envoy::Upstream;

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
// back another inert scope so the policy "<name>_lb." sub-scope construction runs.
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

// A fixed clock for the EDF base. Slow start is out of the initial lift (it needs
// the kernel's virtual clock wired in), and is left disabled (window 0), so the
// time source is only read by the slow-start path's no-ops; a constant epoch is
// sufficient and keeps picks deterministic.
class TimeSourceImpl : public Envoy::TimeSource {
public:
  Envoy::SystemTime systemTime() override { return {}; }
  Envoy::MonotonicTime monotonicTime() override { return {}; }
};

// Build the real PrioritySet/HostSet from the kernel's flat host arrays, grouped
// by priority and partitioned by health, exactly as Envoy's membership update
// would produce it. Shared by every policy.
std::unique_ptr<EU::PrioritySet>
buildPrioritySet(const std::vector<int>& backends, const std::vector<double>& weights,
                 const std::vector<int>& healths, const std::vector<int>& priorities,
                 const std::vector<std::string>& regions, const std::vector<std::string>& zones,
                 const std::vector<int>& active_requests, uint32_t overprovisioning_factor,
                 const ClusterInfoImpl& cluster) {
  uint32_t max_priority = 0;
  for (int p : priorities) {
    max_priority = std::max(max_priority, static_cast<uint32_t>(p));
  }
  std::vector<EU::HostVector> by_priority(max_priority + 1);
  for (size_t i = 0; i < backends.size(); ++i) {
    const auto health = static_cast<EU::Host::Health>(healths[i]);
    const std::string region = i < regions.size() ? regions[i] : std::string();
    const std::string zone = i < zones.size() ? zones[i] : std::string();
    const uint64_t active =
        i < active_requests.size() ? static_cast<uint64_t>(active_requests[i]) : 0;
    by_priority[priorities[i]].push_back(std::make_shared<HostImpl>(
        static_cast<uint32_t>(backends[i]), static_cast<uint32_t>(weights[i]), health, region, zone,
        active, cluster));
  }
  std::vector<EU::HostSetPtr> host_sets;
  host_sets.reserve(by_priority.size());
  for (uint32_t p = 0; p < by_priority.size(); ++p) {
    host_sets.push_back(
        std::make_unique<HostSetImpl>(p, overprovisioning_factor, std::move(by_priority[p])));
  }
  return std::make_unique<PrioritySetImpl>(std::move(host_sets));
}

// Format a 64-bit value as 16 fixed-width lowercase hex chars, so a lexical sort
// of the strings matches the numeric ring order (mirrors the inspection contract).
std::string toHex16(uint64_t v) {
  char buf[17];
  std::snprintf(buf, sizeof(buf), "%016llx", static_cast<unsigned long long>(v));
  return std::string(buf, 16);
}

// ---- The ABI instance -------------------------------------------------------

class LbInstance {
public:
  virtual ~LbInstance() = default;
  virtual void updateHosts(const std::vector<int>& backends, const std::vector<double>& weights,
                           const std::vector<int>& healths, const std::vector<int>& priorities,
                           const std::vector<std::string>& regions,
                           const std::vector<std::string>& zones,
                           const std::vector<int>& active_requests) = 0;
  virtual int chooseHost(double hash) = 0;
  virtual emscripten::val inspect() = 0;
};

// Shared state and host-set rebuild for every concrete policy: the inert Envoy
// leaves (stats/scope/runtime/random/cluster), the panic/overprovisioning knobs,
// and the live PrioritySet. updateHosts() rebuilds the priority set and defers
// the policy-specific LB construction to rebuild().
class LbInstanceBase : public LbInstance {
public:
  LbInstanceBase(uint32_t healthy_panic_threshold, uint32_t overprovisioning_factor, uint32_t seed)
      : healthy_panic_threshold_(healthy_panic_threshold),
        overprovisioning_factor_(overprovisioning_factor), random_(seed) {}

  void updateHosts(const std::vector<int>& backends, const std::vector<double>& weights,
                   const std::vector<int>& healths, const std::vector<int>& priorities,
                   const std::vector<std::string>& regions, const std::vector<std::string>& zones,
                   const std::vector<int>& active_requests) override {
    priority_set_ = buildPrioritySet(backends, weights, healths, priorities, regions, zones,
                                     active_requests, overprovisioning_factor_, cluster_);
    rebuild();
  }

protected:
  // Construct the policy LB from priority_set_ (called on every membership change,
  // matching Envoy's refresh without threading incremental priority callbacks).
  virtual void rebuild() = 0;

  const uint32_t healthy_panic_threshold_;
  const uint32_t overprovisioning_factor_;
  EU::ClusterLbStats stats_{};
  ScopeImpl scope_;
  Envoy::Runtime::Loader runtime_;
  RandomImpl random_;
  ClusterInfoImpl cluster_;
  std::unique_ptr<EU::PrioritySet> priority_set_;
};

// Driver for the ThreadAwareLoadBalancers (maglev, ring_hash): build the immutable
// structure on rebuild(), then resolve a const worker LB that picks per request.
class ThreadAwareLbInstance : public LbInstanceBase {
public:
  using LbInstanceBase::LbInstanceBase;

  int chooseHost(double hash) override { return chooseBackendForHash(static_cast<uint64_t>(hash)); }

protected:
  void rebuild() override {
    lb_ = makeThreadAware(*priority_set_);
    const absl::Status status = lb_->initialize();
    worker_lb_ = status.ok() ? lb_->factory()->create({*priority_set_}) : nullptr;
  }

  // Resolve the backend the real worker LB picks for a precomputed 64-bit hash.
  // The thread-aware worker LB is const/stateless, so probing it here (used by
  // inspect()) does not disturb routing.
  int chooseBackendForHash(uint64_t hash) {
    if (!worker_lb_) {
      return -1;
    }
    ContextImpl ctx(hash);
    const auto host =
        EU::LoadBalancer::onlyAllowSynchronousHostSelection(worker_lb_->chooseHost(&ctx));
    return host ? static_cast<int>(static_cast<const HostImpl&>(*host).backend()) : -1;
  }

  virtual std::unique_ptr<EU::ThreadAwareLoadBalancerBase>
  makeThreadAware(EU::PrioritySet& priority_set) = 0;

  std::unique_ptr<EU::ThreadAwareLoadBalancerBase> lb_;
  EU::LoadBalancerPtr worker_lb_;
};

class MaglevLb : public ThreadAwareLbInstance {
public:
  MaglevLb(uint32_t table_size, bool use_hostname, uint32_t healthy_panic_threshold,
           uint32_t overprovisioning_factor, uint32_t seed)
      : ThreadAwareLbInstance(healthy_panic_threshold, overprovisioning_factor, seed) {
    config_.mutable_table_size()->set_value(table_size);
    config_.mutable_consistent_hashing_lb_config()->set_use_hostname_for_hashing(use_hostname);
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
      table.call<void>("push", chooseBackendForHash(slot));
    }
    out.set("table", table);
    return out;
  }

protected:
  std::unique_ptr<EU::ThreadAwareLoadBalancerBase>
  makeThreadAware(EU::PrioritySet& priority_set) override {
    return std::make_unique<EU::MaglevLoadBalancer>(priority_set, stats_, scope_, runtime_, random_,
                                                    healthy_panic_threshold_, config_, nullptr);
  }

private:
  envoy::extensions::load_balancing_policies::maglev::v3::Maglev config_;
};

class RingHashLb : public ThreadAwareLbInstance {
public:
  using RingHashProto = envoy::extensions::load_balancing_policies::ring_hash::v3::RingHash;

  RingHashLb(uint32_t minimum_ring_size, uint32_t maximum_ring_size, uint32_t hash_function,
             bool use_hostname, uint32_t healthy_panic_threshold, uint32_t overprovisioning_factor,
             uint32_t seed)
      : ThreadAwareLbInstance(healthy_panic_threshold, overprovisioning_factor, seed) {
    config_.mutable_minimum_ring_size()->set_value(minimum_ring_size);
    config_.mutable_maximum_ring_size()->set_value(maximum_ring_size);
    config_.set_hash_function(static_cast<RingHashProto::HashFunction>(hash_function));
    config_.set_use_hostname_for_hashing(use_hostname);
  }

  emscripten::val inspect() override {
    emscripten::val out = emscripten::val::object();
    out.set("kind", std::string("ring"));
    // The real ketama ring (RingHashLoadBalancer::Ring::ring_) is private to the
    // lifted source, which we compile untouched. We expose the ring faithfully by
    // probing the real worker LB at an evenly-spaced grid across the 64-bit hash
    // space: each sample's owning backend is the real ring's answer, so the
    // per-backend tallies are weight/health-accurate ownership shares.
    //
    // The grid resolution TRACKS the configured ring size: Envoy sizes the real
    // ring in [minimumRingSize, maximumRingSize], at least minimumRingSize points,
    // so we sample at minimumRingSize positions (capped to bound the Embind
    // payload; the view downsamples for drawing). This makes the inspector reflect
    // minimumRingSize rather than a fixed grid. `size` is the sampled resolution.
    constexpr uint32_t kMaxSamples = 32768;
    const uint32_t configured = static_cast<uint32_t>(config_.minimum_ring_size().value());
    const uint32_t kSamples = configured < kMaxSamples ? configured : kMaxSamples;
    emscripten::val entries = emscripten::val::array();
    int count = 0;
    if (worker_lb_) {
      for (uint32_t i = 0; i < kSamples; ++i) {
        const uint64_t hash =
            static_cast<uint64_t>((static_cast<__uint128_t>(i) << 64) / kSamples);
        emscripten::val e = emscripten::val::object();
        e.set("hash", toHex16(hash));
        e.set("backend", chooseBackendForHash(hash));
        entries.call<void>("push", e);
        ++count;
      }
    }
    out.set("entries", entries);
    out.set("size", count);
    return out;
  }

protected:
  std::unique_ptr<EU::ThreadAwareLoadBalancerBase>
  makeThreadAware(EU::PrioritySet& priority_set) override {
    return std::make_unique<EU::RingHashLoadBalancer>(priority_set, stats_, scope_, runtime_,
                                                      random_, healthy_panic_threshold_, config_,
                                                      nullptr);
  }

private:
  RingHashProto config_;
};

// Driver for the ZoneAware/EDF load balancers (round_robin, least_request,
// random): these are not thread-aware -- the constructed LB IS the worker LB and
// picks per request via chooseHost(context). The base resolves health/panic/
// priority over the existing host sets in its constructor (and EDF builds its
// schedule in initialize(), called from the subclass ctor), so a fresh rebuild on
// each membership change matches Envoy's refresh.
class ZoneAwareLbInstance : public LbInstanceBase {
public:
  using LbInstanceBase::LbInstanceBase;

  int chooseHost(double hash) override {
    if (!lb_) {
      return -1;
    }
    ContextImpl ctx(static_cast<uint64_t>(hash));
    const auto host = EU::LoadBalancer::onlyAllowSynchronousHostSelection(lb_->chooseHost(&ctx));
    return host ? static_cast<int>(static_cast<const HostImpl&>(*host).backend()) : -1;
  }

protected:
  void rebuild() override { lb_ = makeLb(*priority_set_); }

  virtual std::unique_ptr<EU::LoadBalancer> makeLb(EU::PrioritySet& priority_set) = 0;

  // Effective LB weight for the EDF schedule view. round_robin uses the raw host
  // weight; least_request overrides this to fold in active requests.
  virtual double effectiveWeight(const HostImpl& host) const {
    return static_cast<double>(host.weight());
  }

  // Serialize the weighted round_robin / least_request schedule (EdfInspection).
  // The EDF scheduler the base holds -- its per-host deadlines and virtual clock --
  // is private to the lifted source, which we compile untouched. So we expose the
  // schedule faithfully through the public path: build a throwaway sibling LB over
  // the same host set (leaving the live LB undisturbed) and peek it to discover the
  // real serving set (post health/panic/priority) in scheduler order. Each host's
  // entry carries its effective LB weight and the EDF deadline (1/weight) the
  // scheduler assigns on insert; currentTime is the schedule origin.
  emscripten::val inspectEdf() {
    emscripten::val out = emscripten::val::object();
    out.set("kind", std::string("edf"));
    out.set("currentTime", 0.0);

    std::vector<const HostImpl*> serving;
    std::unique_ptr<EU::LoadBalancer> probe = makeLb(*priority_set_);
    if (probe) {
      constexpr int kPeeks = 2048;
      for (int i = 0; i < kPeeks; ++i) {
        ContextImpl ctx(static_cast<uint64_t>(i));
        const auto host =
            EU::LoadBalancer::onlyAllowSynchronousHostSelection(probe->chooseHost(&ctx));
        if (!host) {
          continue;
        }
        const auto* h = &static_cast<const HostImpl&>(*host);
        bool seen = false;
        for (const auto* s : serving) {
          if (s->backend() == h->backend()) {
            seen = true;
            break;
          }
        }
        if (!seen) {
          serving.push_back(h);
        }
      }
    }
    // Order by EDF deadline ascending (smaller 1/weight = heavier = picked first).
    std::sort(serving.begin(), serving.end(), [this](const HostImpl* a, const HostImpl* b) {
      return effectiveWeight(*a) > effectiveWeight(*b);
    });

    emscripten::val entries = emscripten::val::array();
    for (const auto* h : serving) {
      const double w = effectiveWeight(*h);
      emscripten::val e = emscripten::val::object();
      e.set("backend", static_cast<int>(h->backend()));
      e.set("weight", w);
      e.set("deadline", w > 0.0 ? 1.0 / w : 0.0);
      entries.call<void>("push", e);
    }
    out.set("entries", entries);
    out.set("prepick", emscripten::val::array());
    return out;
  }

  std::unique_ptr<EU::LoadBalancer> lb_;
};

class RoundRobinLb : public ZoneAwareLbInstance {
public:
  RoundRobinLb(uint32_t healthy_panic_threshold, uint32_t overprovisioning_factor, uint32_t seed)
      : ZoneAwareLbInstance(healthy_panic_threshold, overprovisioning_factor, seed) {}

  emscripten::val inspect() override { return inspectEdf(); }

protected:
  std::unique_ptr<EU::LoadBalancer> makeLb(EU::PrioritySet& priority_set) override {
    return std::make_unique<EU::RoundRobinLoadBalancer>(priority_set, nullptr, stats_, runtime_,
                                                        random_, healthy_panic_threshold_, config_,
                                                        time_source_);
  }

private:
  envoy::extensions::load_balancing_policies::round_robin::v3::RoundRobin config_;
  TimeSourceImpl time_source_;
};

class LeastRequestLb : public ZoneAwareLbInstance {
public:
  using LeastRequestProto =
      envoy::extensions::load_balancing_policies::least_request::v3::LeastRequest;

  LeastRequestLb(uint32_t choice_count, double active_request_bias, uint32_t selection_method,
                 uint32_t healthy_panic_threshold, uint32_t overprovisioning_factor, uint32_t seed)
      : ZoneAwareLbInstance(healthy_panic_threshold, overprovisioning_factor, seed),
        active_request_bias_(active_request_bias) {
    config_.mutable_choice_count()->set_value(choice_count);
    config_.mutable_active_request_bias()->set_default_value(active_request_bias);
    config_.set_selection_method(static_cast<LeastRequestProto::SelectionMethod>(selection_method));
  }

  emscripten::val inspect() override { return inspectEdf(); }

protected:
  std::unique_ptr<EU::LoadBalancer> makeLb(EU::PrioritySet& priority_set) override {
    return std::make_unique<EU::LeastRequestLoadBalancer>(priority_set, nullptr, stats_, runtime_,
                                                          random_, healthy_panic_threshold_, config_,
                                                          time_source_);
  }

  // Mirrors least_request_lb.cc hostWeight (sans slow start): the LB weight scaled
  // by active requests, so the schedule view reflects least_request's real bias.
  double effectiveWeight(const HostImpl& host) const override {
    const double weight = static_cast<double>(host.weight());
    const double active_plus_one = static_cast<double>(host.stats().rq_active_.value()) + 1.0;
    if (active_request_bias_ == 0.0) {
      return weight;
    }
    if (active_request_bias_ == 1.0) {
      return weight / active_plus_one;
    }
    return weight / std::pow(active_plus_one, active_request_bias_);
  }

private:
  LeastRequestProto config_;
  TimeSourceImpl time_source_;
  const double active_request_bias_;
};

class RandomLb : public ZoneAwareLbInstance {
public:
  RandomLb(uint32_t healthy_panic_threshold, uint32_t overprovisioning_factor, uint32_t seed)
      : ZoneAwareLbInstance(healthy_panic_threshold, overprovisioning_factor, seed) {}

  // Random keeps no persistent structure.
  emscripten::val inspect() override {
    emscripten::val out = emscripten::val::object();
    out.set("kind", std::string("none"));
    return out;
  }

protected:
  std::unique_ptr<EU::LoadBalancer> makeLb(EU::PrioritySet& priority_set) override {
    return std::make_unique<EU::RandomLoadBalancer>(priority_set, nullptr, stats_, runtime_, random_,
                                                    healthy_panic_threshold_, config_);
  }

private:
  envoy::extensions::load_balancing_policies::random::v3::Random config_;
};

MaglevLb* createMaglevLb(uint32_t table_size, bool use_hostname, uint32_t healthy_panic_threshold,
                         uint32_t overprovisioning_factor, uint32_t seed) {
  return new MaglevLb(table_size, use_hostname, healthy_panic_threshold, overprovisioning_factor,
                      seed);
}

RoundRobinLb* createRoundRobinLb(uint32_t healthy_panic_threshold, uint32_t overprovisioning_factor,
                                 uint32_t seed) {
  return new RoundRobinLb(healthy_panic_threshold, overprovisioning_factor, seed);
}

LeastRequestLb* createLeastRequestLb(uint32_t choice_count, double active_request_bias,
                                     uint32_t selection_method, uint32_t healthy_panic_threshold,
                                     uint32_t overprovisioning_factor, uint32_t seed) {
  return new LeastRequestLb(choice_count, active_request_bias, selection_method,
                            healthy_panic_threshold, overprovisioning_factor, seed);
}

RandomLb* createRandomLb(uint32_t healthy_panic_threshold, uint32_t overprovisioning_factor,
                         uint32_t seed) {
  return new RandomLb(healthy_panic_threshold, overprovisioning_factor, seed);
}

RingHashLb* createRingHashLb(uint32_t minimum_ring_size, uint32_t maximum_ring_size,
                             uint32_t hash_function, bool use_hostname,
                             uint32_t healthy_panic_threshold, uint32_t overprovisioning_factor,
                             uint32_t seed) {
  return new RingHashLb(minimum_ring_size, maximum_ring_size, hash_function, use_hostname,
                        healthy_panic_threshold, overprovisioning_factor, seed);
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
  emscripten::class_<RingHashLb, emscripten::base<LbInstance>>("RingHashLb");
  emscripten::class_<RoundRobinLb, emscripten::base<LbInstance>>("RoundRobinLb");
  emscripten::class_<LeastRequestLb, emscripten::base<LbInstance>>("LeastRequestLb");
  emscripten::class_<RandomLb, emscripten::base<LbInstance>>("RandomLb");

  emscripten::function("createMaglevLb", &createMaglevLb, emscripten::allow_raw_pointers());
  emscripten::function("createRingHashLb", &createRingHashLb, emscripten::allow_raw_pointers());
  emscripten::function("createRoundRobinLb", &createRoundRobinLb, emscripten::allow_raw_pointers());
  emscripten::function("createLeastRequestLb", &createLeastRequestLb,
                       emscripten::allow_raw_pointers());
  emscripten::function("createRandomLb", &createRandomLb, emscripten::allow_raw_pointers());
}
