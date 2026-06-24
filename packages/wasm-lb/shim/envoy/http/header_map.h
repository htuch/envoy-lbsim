#pragma once
// Shim of envoy/http/header_map.h, reduced to what the (compile-only) cookie
// hashing path touches: a header-name key and a response map that can set one.
#include <string>
namespace Envoy {
namespace Http {
class LowerCaseString {
public:
  explicit LowerCaseString(std::string s) : value_(std::move(s)) {}
  const std::string& get() const { return value_; }
private:
  std::string value_;
};
class RequestHeaderMap {};
class ResponseHeaderMap {
public:
  virtual ~ResponseHeaderMap() = default;
  void addReferenceKey(const LowerCaseString&, const std::string&) {}
};
} // namespace Http
} // namespace Envoy
