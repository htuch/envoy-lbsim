#pragma once
// Shim of source/common/common/hex.h: only the uint64 hex formatter is used (the
// compile-only cookie path).
#include <cstdint>
#include <cstdio>
#include <string>

// The cookie hashing path uses HashUtil::xxHash64 alongside Hex here; pull the
// real (bit-faithful) hash header so it is in scope for the lifted thread-aware
// translation unit.
#include "source/common/common/hash.h"

namespace Envoy {
class Hex {
public:
  static std::string uint64ToHex(uint64_t value) {
    char buf[17];
    std::snprintf(buf, sizeof(buf), "%016llx", static_cast<unsigned long long>(value));
    return std::string(buf);
  }
};
} // namespace Envoy
