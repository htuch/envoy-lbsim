#pragma once
// Proto-shaped stand-in for the typed RingHash policy proto
// (envoy.extensions.load_balancing_policies.ring_hash.v3.RingHash). Mirrors the
// accessor names the real ring_hash_lb.cc calls; ring size bounds, the hash
// function, and the hostname-hashing flag are the only fields it reads, and in
// our harness they are driven from @elbsim/config via the Embind ctor rather
// than this message. See ARCHITECTURE.md decision #2 and maglev.pb.h.
#include "envoy/extensions/load_balancing_policies/common/v3/common.pb.h"
#include "google/protobuf/wrappers.h"

namespace envoy {
namespace extensions {
namespace load_balancing_policies {
namespace ring_hash {
namespace v3 {

class RingHash {
public:
  using ConsistentHashingLbConfig =
      envoy::extensions::load_balancing_policies::common::v3::ConsistentHashingLbConfig;
  using LocalityWeightedLbConfig =
      envoy::extensions::load_balancing_policies::common::v3::LocalityLbConfig::LocalityWeightedLbConfig;

  // protoc generates the nested-enum value constants as <Message>_<Enum>_<VALUE>;
  // ring_hash_lb.cc compares against RingHash_HashFunction_MURMUR_HASH_2, and the
  // typed-config path references the unqualified XX_HASH / MURMUR_HASH_2 aliases.
  enum HashFunction {
    RingHash_HashFunction_DEFAULT_HASH = 0,
    RingHash_HashFunction_XX_HASH = 1,
    RingHash_HashFunction_MURMUR_HASH_2 = 2,
  };
  static constexpr HashFunction DEFAULT_HASH = RingHash_HashFunction_DEFAULT_HASH;
  static constexpr HashFunction XX_HASH = RingHash_HashFunction_XX_HASH;
  static constexpr HashFunction MURMUR_HASH_2 = RingHash_HashFunction_MURMUR_HASH_2;

  HashFunction hash_function() const { return hash_function_; }
  void set_hash_function(HashFunction v) { hash_function_ = v; }

  bool has_minimum_ring_size() const { return has_min_ring_size_; }
  const google::protobuf::UInt64Value& minimum_ring_size() const { return minimum_ring_size_; }
  google::protobuf::UInt64Value* mutable_minimum_ring_size() {
    has_min_ring_size_ = true;
    return &minimum_ring_size_;
  }

  bool has_maximum_ring_size() const { return has_max_ring_size_; }
  const google::protobuf::UInt64Value& maximum_ring_size() const { return maximum_ring_size_; }
  google::protobuf::UInt64Value* mutable_maximum_ring_size() {
    has_max_ring_size_ = true;
    return &maximum_ring_size_;
  }

  bool use_hostname_for_hashing() const { return use_hostname_for_hashing_; }
  void set_use_hostname_for_hashing(bool v) { use_hostname_for_hashing_ = v; }

  // Bounded-load hashing (hash_balance_factor) is not exposed by @elbsim/config,
  // so the field stays unset and the real ctor reads 0 (BoundedLoad disabled).
  bool has_hash_balance_factor() const { return false; }
  const google::protobuf::UInt32Value& hash_balance_factor() const { return hash_balance_factor_; }
  google::protobuf::UInt32Value* mutable_hash_balance_factor() { return &hash_balance_factor_; }

  // We drive use_hostname_for_hashing via the top-level field, so the nested
  // consistent-hashing config stays unset and the real ctor takes the top-level
  // branch. mutable_* exists only to satisfy the typed-config conversion path.
  bool has_consistent_hashing_lb_config() const { return false; }
  const ConsistentHashingLbConfig& consistent_hashing_lb_config() const { return chlb_; }
  ConsistentHashingLbConfig* mutable_consistent_hashing_lb_config() { return &chlb_; }

  bool has_locality_weighted_lb_config() const { return false; }
  const LocalityWeightedLbConfig& locality_weighted_lb_config() const { return lwlb_; }
  LocalityWeightedLbConfig* mutable_locality_weighted_lb_config() { return &lwlb_; }

private:
  HashFunction hash_function_{RingHash_HashFunction_DEFAULT_HASH};
  bool has_min_ring_size_{false};
  bool has_max_ring_size_{false};
  bool use_hostname_for_hashing_{false};
  google::protobuf::UInt64Value minimum_ring_size_;
  google::protobuf::UInt64Value maximum_ring_size_;
  google::protobuf::UInt32Value hash_balance_factor_;
  ConsistentHashingLbConfig chlb_;
  LocalityWeightedLbConfig lwlb_;
};

} // namespace v3
} // namespace ring_hash
} // namespace load_balancing_policies
} // namespace extensions
} // namespace envoy
