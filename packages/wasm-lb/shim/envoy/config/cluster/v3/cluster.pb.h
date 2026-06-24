#pragma once
// Proto-shaped stand-in for envoy::config::cluster::v3::Cluster, reduced to the
// nested config messages the lifted maglev/ring_hash code names: the legacy
// in-cluster MaglevLbConfig/CommonLbConfig. Only the accessors the real .cc
// calls exist; field-backed state is unused in our harness (the kernel supplies
// resolved hosts and the policy knobs come from @elbsim/config), so these return
// empty defaults. See ARCHITECTURE.md decision #2.
#include "google/protobuf/wrappers.h"

namespace envoy {
namespace config {
namespace cluster {
namespace v3 {

class Cluster {
public:
  class CommonLbConfig {
  public:
    bool has_locality_weighted_lb_config() const { return false; }
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
