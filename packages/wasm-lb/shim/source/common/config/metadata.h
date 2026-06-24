#pragma once
// Shim of source/common/config/metadata.h. metadataValue() pulls a value out of a
// host's structured metadata; our host model has no metadata, so this always
// returns an unset Value and the consistent-hash key falls back to the address.
#include "envoy/config/core/v3/base.pb.h"
#include "source/common/protobuf/protobuf.h"
#include "absl/strings/string_view.h"
namespace Envoy {
namespace Config {
class Metadata {
public:
  static const Protobuf::Value& metadataValue(const envoy::config::core::v3::Metadata*,
                                              absl::string_view, absl::string_view) {
    static const Protobuf::Value unset;
    return unset;
  }
};
} // namespace Config
} // namespace Envoy
