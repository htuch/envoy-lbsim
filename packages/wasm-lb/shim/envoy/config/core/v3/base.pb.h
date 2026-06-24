#pragma once
// Proto-shaped stand-in for the envoy.config.core.v3 messages the lifted LB
// touches: Locality (zone-aware routing reads region/zone/sub_zone) and an opaque
// Metadata (the per-host hash-key metadata path is shimmed out, so only the type
// name is needed). The kernel supplies region/zone via the ABI; we populate a
// real Locality on each host so Envoy's zone-aware logic runs faithfully.
#include <string>

namespace envoy {
namespace config {
namespace core {
namespace v3 {

class Locality {
public:
  const std::string& region() const { return region_; }
  const std::string& zone() const { return zone_; }
  const std::string& sub_zone() const { return sub_zone_; }
  void set_region(const std::string& v) { region_ = v; }
  void set_zone(const std::string& v) { zone_ = v; }
  void set_sub_zone(const std::string& v) { sub_zone_ = v; }

  bool operator==(const Locality& other) const {
    return region_ == other.region_ && zone_ == other.zone_ && sub_zone_ == other.sub_zone_;
  }

private:
  std::string region_;
  std::string zone_;
  std::string sub_zone_;
};

// The lifted code only passes Metadata around by pointer (the metadata hash-key
// lookup is shimmed out); an opaque type satisfies the references.
class Metadata {};

// Runtime-overridable value wrappers. The harness has no runtime layer, so these
// just carry their default; used only by the (compile-only-for-maglev) slow-start
// path.
class RuntimeDouble {
public:
  const std::string& runtime_key() const { return runtime_key_; }
  double default_value() const { return default_value_; }

private:
  std::string runtime_key_;
  double default_value_{0.0};
};

} // namespace v3
} // namespace core
} // namespace config
} // namespace envoy
