#pragma once
// Proto-shaped stub for the least_request policy config (see round_robin.pb.h).
// Fields (choice_count, active_request_bias, selection_method) are read by
// least_request_lb.cc when it is lifted; the type alone suffices for the base.
#include "envoy/extensions/load_balancing_policies/common/v3/common.pb.h"
namespace envoy { namespace extensions { namespace load_balancing_policies { namespace least_request { namespace v3 {
class LeastRequest {};
} } } } }
