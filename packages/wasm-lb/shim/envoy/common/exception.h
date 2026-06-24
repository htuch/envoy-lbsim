#pragma once
// Shim of envoy/common/exception.h. The lifted maglev ctor throws EnvoyException
// on a non-prime table size; our config layer already validates table size, so
// this path is inert, but we keep a real exception type so the throw compiles
// and behaves if ever hit.
#include <stdexcept>
#include <string>

namespace Envoy {

class EnvoyException : public std::runtime_error {
public:
  explicit EnvoyException(const std::string& message) : std::runtime_error(message) {}
};

} // namespace Envoy
