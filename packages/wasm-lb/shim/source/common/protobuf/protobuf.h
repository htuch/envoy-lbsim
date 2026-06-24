#pragma once
// Minimal shim of source/common/protobuf/protobuf.h. The lifted code reads a
// single google.protobuf.Value out of host metadata (the hash-key path); our
// hosts carry no metadata, so this always reports "unset" and the LB falls back
// to the address/hostname hash identity. No protobuf runtime is linked.
#include <string>
namespace Envoy {
namespace Protobuf {
class Value {
public:
  enum KindCase { KIND_NOT_SET = 0, kStringValue = 3 };
  KindCase kind_case() const { return KIND_NOT_SET; }
  const std::string& string_value() const {
    static const std::string empty;
    return empty;
  }
};
} // namespace Protobuf
namespace ProtobufWkt {
using Value = Envoy::Protobuf::Value;
} // namespace ProtobufWkt
} // namespace Envoy
