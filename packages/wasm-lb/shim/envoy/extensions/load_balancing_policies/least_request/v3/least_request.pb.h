#pragma once
// Proto-shaped stand-in for the least_request policy config. least_request_lb.cc
// reads choice_count, active_request_bias, and selection_method (all driven from
// @elbsim/config via the Embind ctor); the locality and slow-start sub-configs are
// left unset so the EDF base takes its defaults. The active-request weighting
// itself runs for real off the per-host rq_active_ stat fed across the ABI. See
// round_robin.pb.h and ARCHITECTURE.md decision #2.
#include "envoy/config/core/v3/base.pb.h"
#include "envoy/extensions/load_balancing_policies/common/v3/common.pb.h"
#include "google/protobuf/wrappers.h"

namespace envoy {
namespace extensions {
namespace load_balancing_policies {
namespace least_request {
namespace v3 {

class LeastRequest {
public:
  using SlowStartConfig = envoy::extensions::load_balancing_policies::common::v3::SlowStartConfig;
  using LocalityLbConfig = envoy::extensions::load_balancing_policies::common::v3::LocalityLbConfig;

  // protoc names nested-enum constants <Message>_<Enum>_<VALUE>; least_request_lb.cc
  // switches on LeastRequest::FULL_SCAN / LeastRequest::N_CHOICES.
  enum SelectionMethod {
    LeastRequest_SelectionMethod_N_CHOICES = 0,
    LeastRequest_SelectionMethod_FULL_SCAN = 1,
  };
  static constexpr SelectionMethod N_CHOICES = LeastRequest_SelectionMethod_N_CHOICES;
  static constexpr SelectionMethod FULL_SCAN = LeastRequest_SelectionMethod_FULL_SCAN;

  bool has_choice_count() const { return has_choice_count_; }
  const google::protobuf::UInt32Value& choice_count() const { return choice_count_; }
  google::protobuf::UInt32Value* mutable_choice_count() {
    has_choice_count_ = true;
    return &choice_count_;
  }

  bool has_active_request_bias() const { return has_active_request_bias_; }
  const envoy::config::core::v3::RuntimeDouble& active_request_bias() const {
    return active_request_bias_;
  }
  envoy::config::core::v3::RuntimeDouble* mutable_active_request_bias() {
    has_active_request_bias_ = true;
    return &active_request_bias_;
  }

  SelectionMethod selection_method() const { return selection_method_; }
  void set_selection_method(SelectionMethod v) { selection_method_ = v; }

  bool has_slow_start_config() const { return false; }
  const SlowStartConfig& slow_start_config() const { return slow_start_config_; }
  SlowStartConfig* mutable_slow_start_config() { return &slow_start_config_; }

  bool has_locality_lb_config() const { return false; }
  const LocalityLbConfig& locality_lb_config() const { return locality_lb_config_; }
  LocalityLbConfig* mutable_locality_lb_config() { return &locality_lb_config_; }

private:
  bool has_choice_count_{false};
  bool has_active_request_bias_{false};
  google::protobuf::UInt32Value choice_count_;
  envoy::config::core::v3::RuntimeDouble active_request_bias_;
  SelectionMethod selection_method_{LeastRequest_SelectionMethod_N_CHOICES};
  SlowStartConfig slow_start_config_;
  LocalityLbConfig locality_lb_config_;
};

} // namespace v3
} // namespace least_request
} // namespace load_balancing_policies
} // namespace extensions
} // namespace envoy
