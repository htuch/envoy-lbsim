#pragma once
// Shim of source/common/protobuf/utility.h, reduced to the macros and helpers the
// lifted LB code uses. We replicate the upstream expansions so the real .cc
// compiles unmodified without the protobuf runtime. The percent/duration helpers
// feed maglev-irrelevant paths (panic-threshold rounding, slow-start window) but
// must compile in the shared translation unit.
#include <cstdint>

// Reads a google.protobuf wrapper field, falling back to a default when unset.
#define PROTOBUF_GET_WRAPPED_OR_DEFAULT(message, field_name, default_value)                        \
  ((message).has_##field_name() ? (message).field_name().value() : (default_value))

// envoy.type.v3.Percent is a 0..100 double. Round to an integer percentage, or
// use the default when the field is unset.
#define PROTOBUF_PERCENT_TO_ROUNDED_INTEGER_OR_DEFAULT(message, field_name, max_value,             \
                                                       default_value)                              \
  ((message).has_##field_name()                                                                    \
       ? static_cast<uint64_t>((message).field_name().value() / 100.0 * (max_value) + 0.5)         \
       : (default_value))

#define PROTOBUF_PERCENT_TO_DOUBLE_OR_DEFAULT(message, field_name, default_value)                  \
  ((message).has_##field_name() ? (message).field_name().value() / 100.0 : (default_value))

namespace Envoy {

// Reduced DurationUtil: only milliseconds conversion is used (slow-start window).
class DurationUtil {
public:
  template <class Duration> static uint64_t durationToMilliseconds(const Duration& d) {
    return static_cast<uint64_t>(d.seconds()) * 1000 + static_cast<uint64_t>(d.nanos()) / 1000000;
  }
};

} // namespace Envoy
