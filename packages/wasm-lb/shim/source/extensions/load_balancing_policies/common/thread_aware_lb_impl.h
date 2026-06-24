#pragma once
// Faithful-minimal shadow of thread_aware_lb_impl.h.
//
// The real header pulls Envoy's entire host-set partitioning base
// (load_balancer_impl.{h,cc}), the HTTP hash-policy codec, config metadata, and
// the cluster proto -- i.e. priority/locality/panic orchestration that, in this
// project, is the kernel's job (see ARCHITECTURE.md), not the Wasm LB's. We
// shadow it so the REAL maglev_lb.cc compiles UNTOUCHED while we drive the real
// MaglevTable directly from a resolved, normalized host-weight vector.
//
// Two consequences make this safe:
//  - We never instantiate MaglevLoadBalancer (the thread-aware wrapper); it stays
//    abstract. So this base only needs to COMPILE its constructor, not behave.
//  - hashKey() drops the metadata hash-key lookup (absent in our host model) and
//    falls back to hostname/address exactly as upstream does when no metadata key
//    is set -- which is always, in the harness.
#include <cstdint>
#include <map>
#include <memory>
#include <utility>
#include <vector>

#include "absl/numeric/bits.h"
#include "absl/status/status.h"
#include "absl/strings/string_view.h"
#include "absl/types/span.h"

#include "envoy/common/exception.h"
#include "envoy/common/pure.h"
#include "envoy/common/random_generator.h"
#include "envoy/common/regex.h"
#include "envoy/config/route/v3/route_components.pb.h"
#include "envoy/runtime/runtime.h"
#include "envoy/upstream/load_balancer.h"
#include "envoy/upstream/upstream.h"

#include "source/common/common/hash.h"     // REAL: HashUtil::xxHash64 (bit-faithful)
#include "source/common/common/logger.h"   // shim
#include "source/common/common/utility.h"  // shim: Primes::isPrime
#include "source/common/protobuf/utility.h" // shim: PROTOBUF_GET_WRAPPED_OR_DEFAULT

namespace Envoy {
namespace Upstream {

using NormalizedHostWeightVector = std::vector<std::pair<HostConstSharedPtr, double>>;
using NormalizedHostWeightMap = std::map<HostConstSharedPtr, double>;

using HashPolicyProto = envoy::config::route::v3::RouteAction::HashPolicy;
// Real type is std::shared_ptr<Http::HashPolicy>; the harness precomputes hashes
// and never consults a policy, so an opaque handle suffices.
class HashPolicyStub {};
using HashPolicySharedPtr = std::shared_ptr<HashPolicyStub>;

// The real LoadBalancerBase resolves priority/health/locality into a per-priority
// host set. The kernel does that; this stand-in only carries the constructor
// shape the thread-aware base forwards to.
class LoadBalancerBase {
protected:
  LoadBalancerBase(const PrioritySet&, ClusterLbStats&, Runtime::Loader&, Random::RandomGenerator&,
                   uint32_t) {}
};

class ThreadAwareLoadBalancerBase : public LoadBalancerBase {
public:
  // Inner interface the consistent-hash tables implement (maglev/ring_hash).
  class HashingLoadBalancer {
  public:
    virtual ~HashingLoadBalancer() = default;
    virtual HostSelectionResponse chooseHost(uint64_t hash, uint32_t attempt) const PURE;
    // Upstream resolves a per-host metadata "hash_key" first; our host model has
    // no such metadata, so this is the always-taken fallback path.
    absl::string_view hashKey(HostConstSharedPtr host, bool use_hostname) const {
      return use_hostname ? absl::string_view(host->hostname())
                          : absl::string_view(host->address()->asString());
    }
  };
  using HashingLoadBalancerSharedPtr = std::shared_ptr<HashingLoadBalancer>;

  // Bounded-load wrapper. Only reached when hash_balance_factor != 0, which our
  // config never sets; it must merely be concrete so createLoadBalancer compiles.
  class BoundedLoadHashingLoadBalancer : public HashingLoadBalancer {
  public:
    BoundedLoadHashingLoadBalancer(HashingLoadBalancerSharedPtr hashing_lb_ptr,
                                   NormalizedHostWeightVector, uint32_t)
        : hashing_lb_ptr_(std::move(hashing_lb_ptr)) {}
    HostSelectionResponse chooseHost(uint64_t hash, uint32_t attempt) const override {
      return hashing_lb_ptr_->chooseHost(hash, attempt);
    }

  private:
    const HashingLoadBalancerSharedPtr hashing_lb_ptr_;
  };

protected:
  ThreadAwareLoadBalancerBase(const PrioritySet& priority_set, ClusterLbStats& stats,
                              Runtime::Loader& runtime, Random::RandomGenerator& random,
                              uint32_t healthy_panic_threshold,
                              bool /*locality_weighted_balancing*/,
                              HashPolicySharedPtr /*hash_policy*/)
      : LoadBalancerBase(priority_set, stats, runtime, random, healthy_panic_threshold) {}

  virtual HashingLoadBalancerSharedPtr
  createLoadBalancer(const NormalizedHostWeightVector& normalized_host_weights,
                     double min_normalized_weight, double max_normalized_weight) PURE;
};

// Base for the typed hash-LB configs. Real one derives from LoadBalancerConfig and
// validates endpoints; neither is exercised here.
class TypedHashLbConfigBase {
public:
  TypedHashLbConfigBase() = default;
  TypedHashLbConfigBase(absl::Span<const HashPolicyProto* const>, Regex::Engine&, absl::Status&) {}
  HashPolicySharedPtr hash_policy_;
};

// Helper named by the legacy maglev config constructor (never instantiated). A
// no-op definition keeps the link clean regardless of dead-code elimination.
class LoadBalancerConfigHelper {
public:
  template <class CommonProto, class TypedProto>
  static void convertHashLbConfigTo(const CommonProto&, TypedProto&) {}
};

} // namespace Upstream
} // namespace Envoy
