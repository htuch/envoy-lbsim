#pragma once
// Proto-shaped stand-in for envoy::config::cluster::v3::Cluster, reduced to the
// nested config messages the lifted maglev/ring_hash code names: the legacy
// in-cluster MaglevLbConfig/CommonLbConfig. Only the accessors the real .cc
// calls exist; field-backed state is unused in our harness (the kernel supplies
// resolved hosts and the policy knobs come from @elbsim/config), so these return
// empty defaults. See ARCHITECTURE.md decision #2.
#include "envoy/type/v3/percent.pb.h"
#include "google/protobuf/wrappers.h"

namespace envoy {
namespace config {
namespace cluster {
namespace v3 {

class Cluster {
public:
  class CommonLbConfig {
  public:
    // Legacy in-Cluster consistent-hashing config; the maglev legacy ctor reads
    // it to convert into the typed extension proto.
    class ConsistentHashingLbConfig {
    public:
      bool use_hostname_for_hashing() const { return false; }
      bool has_hash_balance_factor() const { return false; }
      const google::protobuf::UInt32Value& hash_balance_factor() const {
        static const google::protobuf::UInt32Value v;
        return v;
      }
    };

    // Legacy in-Cluster zone-aware config; read by the locality-config conversion
    // helper (instantiated only for the EDF-base policies, not maglev).
    class ZoneAwareLbConfig {
    public:
      bool fail_traffic_on_panic() const { return false; }
      bool has_routing_enabled() const { return false; }
      const envoy::type::v3::Percent& routing_enabled() const {
        static const envoy::type::v3::Percent v;
        return v;
      }
      bool has_min_cluster_size() const { return false; }
      const google::protobuf::UInt64Value& min_cluster_size() const {
        static const google::protobuf::UInt64Value v;
        return v;
      }
    };

    bool has_locality_weighted_lb_config() const { return false; }
    bool has_zone_aware_lb_config() const { return false; }
    const ZoneAwareLbConfig& zone_aware_lb_config() const {
      static const ZoneAwareLbConfig v;
      return v;
    }
    bool has_consistent_hashing_lb_config() const { return false; }
    const ConsistentHashingLbConfig& consistent_hashing_lb_config() const {
      static const ConsistentHashingLbConfig v;
      return v;
    }
  };

  // Legacy in-Cluster maglev config (superseded by the typed extension proto).
  class MaglevLbConfig {
  public:
    bool has_table_size() const { return false; }
    const google::protobuf::UInt64Value& table_size() const {
      static const google::protobuf::UInt64Value v;
      return v;
    }
  };
};

} // namespace v3
} // namespace cluster
} // namespace config
} // namespace envoy
