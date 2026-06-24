#pragma once
// Shim of source/common/config/well_known_names.h: the metadata filter/key names
// the lifted hashKey() looks up (always absent in the harness).
#include <string>
#include "source/common/singleton/const_singleton.h"
namespace Envoy {
namespace Config {
class MetadataFilterValues {
public:
  const std::string ENVOY_LB = "envoy.lb";
};
using MetadataFilters = ConstSingleton<MetadataFilterValues>;
class MetadataEnvoyLbKeyValues {
public:
  const std::string HASH_KEY = "hash_key";
};
using MetadataEnvoyLbKeys = ConstSingleton<MetadataEnvoyLbKeyValues>;
} // namespace Config
} // namespace Envoy
