#pragma once
// Proto-shaped stand-ins for the common load-balancing-policy config messages the
// lifted LB base and maglev reference. Mirrors the accessor names the real .cc
// calls; in the harness these knobs come from @elbsim/config (locality mode,
// panic threshold), so the proto defaults are inert. The zone-aware and
// slow-start surfaces are compile-only for maglev (it never constructs them) but
// are exercised when the EDF-base policies are lifted. See ARCHITECTURE.md #2.
#include "absl/types/span.h"

#include "envoy/config/core/v3/base.pb.h"
#include "envoy/config/route/v3/route_components.pb.h"
#include "envoy/type/v3/percent.pb.h"
#include "google/protobuf/duration.h"
#include "google/protobuf/wrappers.h"

namespace envoy {
namespace extensions {
namespace load_balancing_policies {
namespace common {
namespace v3 {

using HashPolicyProto = envoy::config::route::v3::RouteAction::HashPolicy;

class ConsistentHashingLbConfig {
public:
  bool use_hostname_for_hashing() const { return use_hostname_for_hashing_; }
  void set_use_hostname_for_hashing(bool v) { use_hostname_for_hashing_ = v; }
  bool has_hash_balance_factor() const { return false; }
  const google::protobuf::UInt32Value& hash_balance_factor() const { return hash_balance_factor_; }
  google::protobuf::UInt32Value* mutable_hash_balance_factor() { return &hash_balance_factor_; }
  absl::Span<const HashPolicyProto* const> hash_policy() const { return {}; }

private:
  bool use_hostname_for_hashing_{false};
  google::protobuf::UInt32Value hash_balance_factor_;
};

class LocalityLbConfig {
public:
  class ZoneAwareLbConfig {
  public:
    enum LocalityBasis {
      HEALTHY_HOSTS_NUM = 0,
      HEALTHY_HOSTS_WEIGHT = 1,
    };

    class ForceLocalZone {
    public:
      bool has_min_size() const { return false; }
      const google::protobuf::UInt32Value& min_size() const {
        static const google::protobuf::UInt32Value v;
        return v;
      }
      google::protobuf::UInt32Value* mutable_min_size() { return &min_size_; }

    private:
      google::protobuf::UInt32Value min_size_;
    };

    bool has_routing_enabled() const { return false; }
    const envoy::type::v3::Percent& routing_enabled() const { return routing_enabled_; }
    envoy::type::v3::Percent* mutable_routing_enabled() { return &routing_enabled_; }
    bool has_min_cluster_size() const { return false; }
    const google::protobuf::UInt64Value& min_cluster_size() const { return min_cluster_size_; }
    google::protobuf::UInt64Value* mutable_min_cluster_size() { return &min_cluster_size_; }
    bool fail_traffic_on_panic() const { return fail_traffic_on_panic_; }
    // Setter exists only for the never-invoked legacy-config conversion path
    // (convertLocalityLbConfigTo); the harness drives locality mode from config.
    void set_fail_traffic_on_panic(bool v) { fail_traffic_on_panic_ = v; }
    bool force_locality_direct_routing() const { return false; }
    bool has_force_local_zone() const { return false; }
    const ForceLocalZone& force_local_zone() const { return force_local_zone_; }
    ForceLocalZone* mutable_force_local_zone() { return &force_local_zone_; }
    LocalityBasis locality_basis() const { return HEALTHY_HOSTS_NUM; }

  private:
    envoy::type::v3::Percent routing_enabled_;
    google::protobuf::UInt64Value min_cluster_size_;
    ForceLocalZone force_local_zone_;
    bool fail_traffic_on_panic_{false};
  };

  class LocalityWeightedLbConfig {};

  bool has_zone_aware_lb_config() const { return false; }
  const ZoneAwareLbConfig& zone_aware_lb_config() const { return zone_aware_; }
  ZoneAwareLbConfig* mutable_zone_aware_lb_config() { return &zone_aware_; }
  bool has_locality_weighted_lb_config() const { return false; }
  const LocalityWeightedLbConfig& locality_weighted_lb_config() const { return locality_weighted_; }
  LocalityWeightedLbConfig* mutable_locality_weighted_lb_config() { return &locality_weighted_; }

private:
  ZoneAwareLbConfig zone_aware_;
  LocalityWeightedLbConfig locality_weighted_;
};

class SlowStartConfig {
public:
  bool has_slow_start_window() const { return false; }
  const google::protobuf::Duration& slow_start_window() const { return slow_start_window_; }
  google::protobuf::Duration* mutable_slow_start_window() { return &slow_start_window_; }
  bool has_aggression() const { return false; }
  const envoy::config::core::v3::RuntimeDouble& aggression() const { return aggression_; }
  envoy::config::core::v3::RuntimeDouble* mutable_aggression() { return &aggression_; }
  bool has_min_weight_percent() const { return false; }
  const envoy::type::v3::Percent& min_weight_percent() const { return min_weight_percent_; }
  envoy::type::v3::Percent* mutable_min_weight_percent() { return &min_weight_percent_; }

private:
  google::protobuf::Duration slow_start_window_;
  envoy::config::core::v3::RuntimeDouble aggression_;
  envoy::type::v3::Percent min_weight_percent_;
};

} // namespace v3
} // namespace common
} // namespace load_balancing_policies
} // namespace extensions
} // namespace envoy
