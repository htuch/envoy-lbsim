#pragma once
// Shim of source/common/http/headers.h, reduced to the one header name the
// compile-only cookie path references.
#include "envoy/http/header_map.h"
#include "source/common/singleton/const_singleton.h"
namespace Envoy {
namespace Http {
class HeaderValues {
public:
  const LowerCaseString SetCookie{"set-cookie"};
};
using Headers = ConstSingleton<HeaderValues>;
} // namespace Http
} // namespace Envoy
