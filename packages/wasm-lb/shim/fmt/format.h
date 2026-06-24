#pragma once
// Minimal {fmt} shim. The lifted code formats human-readable error/log strings
// via fmt::format; in the harness those strings are never surfaced, so format()
// returns empty. Real {fmt} (pulled by spdlog) is not linked.
#include <string>
namespace fmt {
template <class... Args> inline std::string format(Args&&...) { return std::string(); }
template <class T> inline T runtime(T&& t) { return std::forward<T>(t); }
} // namespace fmt
