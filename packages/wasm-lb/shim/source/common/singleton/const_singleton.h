#pragma once
// Shim of source/common/singleton/const_singleton.h: a process-wide const
// instance accessed via get(). Used for well-known metadata name tables.
namespace Envoy {
template <class T> class ConstSingleton {
public:
  static const T& get() {
    static const T instance;
    return instance;
  }
};
} // namespace Envoy
