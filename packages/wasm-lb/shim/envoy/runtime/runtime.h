#pragma once
// Shim of envoy/runtime/runtime.h. Envoy's Runtime layer lets operators override
// config values live; the sim has no such layer, so our Snapshot returns the
// caller-supplied defaults (which carry the values from @elbsim/config). This
// keeps the lifted LB's runtime-gated branches (zone-routing knobs, panic
// threshold) deterministic and driven entirely by config. featureEnabled treats
// a percentage as on only at 100 (our zone-aware default), avoiding a random roll.
#include <cstdint>
#include <string>

namespace Envoy {
namespace Runtime {

class Snapshot {
public:
  virtual ~Snapshot() = default;
  virtual uint64_t getInteger(const std::string& /*key*/, uint64_t default_value) const {
    return default_value;
  }
  virtual double getDouble(const std::string& /*key*/, double default_value) const {
    return default_value;
  }
  virtual bool getBoolean(const std::string& /*key*/, bool default_value) const {
    return default_value;
  }
  virtual bool featureEnabled(const std::string& /*key*/, uint64_t default_value) const {
    return default_value >= 100;
  }
};

class Loader {
public:
  virtual ~Loader() = default;
  virtual Snapshot& snapshot() {
    static Snapshot snapshot;
    return snapshot;
  }
};

} // namespace Runtime
} // namespace Envoy
