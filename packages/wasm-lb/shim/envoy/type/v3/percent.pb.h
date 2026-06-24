#pragma once
// Proto-shaped stand-in for envoy.type.v3 percent messages referenced by the
// lifted LB config (e.g. slow-start min_weight_percent). Only value accessors are
// used; the harness drives these knobs from @elbsim/config, so defaults are inert.
namespace envoy {
namespace type {
namespace v3 {

class Percent {
public:
  double value() const { return value_; }
  void set_value(double v) { value_ = v; }

private:
  double value_{0.0};
};

class FractionalPercent {
public:
  uint32_t numerator() const { return numerator_; }

private:
  uint32_t numerator_{0};
};

} // namespace v3
} // namespace type
} // namespace envoy
