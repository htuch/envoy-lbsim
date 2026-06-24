#pragma once
// Minimal stand-in for google.protobuf.Duration (slow-start window). Only the
// seconds/nanos accessors are used, via DurationUtil; slow start is not exercised
// in the harness, so defaults are inert.
#include <cstdint>
namespace google { namespace protobuf {
class Duration {
public:
  int64_t seconds() const { return seconds_; }
  int32_t nanos() const { return nanos_; }
  void set_seconds(int64_t s) { seconds_ = s; }
  void set_nanos(int32_t n) { nanos_ = n; }
private:
  int64_t seconds_{0};
  int32_t nanos_{0};
};
} }
