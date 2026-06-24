#pragma once
// Shim of envoy/common/time.h. Slow start and the host hc-pass timestamp use a
// TimeSource; slow start is out of the initial lift (it needs a virtual time
// source wired from the kernel), so this provides the chrono typedefs and a
// monotone TimeSource stub. When slow start is enabled later, the kernel's
// virtual clock should drive a real implementation of this interface.
#include <chrono>

namespace Envoy {

using MonotonicTime = std::chrono::time_point<std::chrono::steady_clock, std::chrono::nanoseconds>;
using SystemTime = std::chrono::time_point<std::chrono::system_clock, std::chrono::nanoseconds>;

class MonotonicTimeSource {
public:
  virtual ~MonotonicTimeSource() = default;
  virtual MonotonicTime monotonicTime() PURE;
};

class SystemTimeSource {
public:
  virtual ~SystemTimeSource() = default;
  virtual SystemTime systemTime() PURE;
};

class TimeSource {
public:
  virtual ~TimeSource() = default;
  virtual SystemTime systemTime() PURE;
  virtual MonotonicTime monotonicTime() PURE;
};

} // namespace Envoy
