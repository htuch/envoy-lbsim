#pragma once
// Proto-shaped stand-in for the typed Maglev policy proto
// (envoy.extensions.load_balancing_policies.maglev.v3.Maglev). Mirrors the
// accessor names the real maglev_lb.cc calls; table_size and the hashing config
// are the only fields it reads, and in our harness they are driven from
// @elbsim/config rather than this message, so the defaults are inert. See
// ARCHITECTURE.md decision #2.
#include "envoy/extensions/load_balancing_policies/common/v3/common.pb.h"
#include "google/protobuf/wrappers.h"

namespace envoy {
namespace extensions {
namespace load_balancing_policies {
namespace maglev {
namespace v3 {

class Maglev {
public:
  using ConsistentHashingLbConfig =
      envoy::extensions::load_balancing_policies::common::v3::ConsistentHashingLbConfig;
  using LocalityWeightedLbConfig =
      envoy::extensions::load_balancing_policies::common::v3::LocalityLbConfig::LocalityWeightedLbConfig;

  // The kernel sets table_size via mutable_table_size() so the real
  // MaglevLoadBalancer ctor reads our configured size (it uses
  // PROTOBUF_GET_WRAPPED_OR_DEFAULT(config, table_size, DefaultTableSize)).
  bool has_table_size() const { return has_table_size_; }
  const google::protobuf::UInt64Value& table_size() const { return table_size_; }
  google::protobuf::UInt64Value* mutable_table_size() {
    has_table_size_ = true;
    return &table_size_;
  }

  bool has_consistent_hashing_lb_config() const { return has_chlb_; }
  const ConsistentHashingLbConfig& consistent_hashing_lb_config() const { return chlb_; }
  ConsistentHashingLbConfig* mutable_consistent_hashing_lb_config() {
    has_chlb_ = true;
    return &chlb_;
  }

  bool has_locality_weighted_lb_config() const { return false; }
  LocalityWeightedLbConfig* mutable_locality_weighted_lb_config() { return &lwlb_; }

private:
  bool has_table_size_{false};
  bool has_chlb_{false};
  google::protobuf::UInt64Value table_size_;
  ConsistentHashingLbConfig chlb_;
  LocalityWeightedLbConfig lwlb_;
};

} // namespace v3
} // namespace maglev
} // namespace load_balancing_policies
} // namespace extensions
} // namespace envoy
