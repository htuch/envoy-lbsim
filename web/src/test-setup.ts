import '@testing-library/jest-dom/vitest';

// React Flow (topology graph) measures its container via ResizeObserver and
// DOMMatrixReadOnly, neither of which jsdom implements. Provide minimal stubs so
// the graph mounts under test; layout correctness is covered by the pure
// `layoutTopology` unit tests, not by measured rendering.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

if (!('DOMMatrixReadOnly' in globalThis)) {
  // React Flow constructs this with a transform string it then ignores under
  // test; the default constructor discards the argument.
  class DOMMatrixReadOnlyStub {
    m22 = 1;
  }
  (globalThis as Record<string, unknown>).DOMMatrixReadOnly = DOMMatrixReadOnlyStub;
}
