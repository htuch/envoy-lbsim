import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSimStore } from '@/store/sim-store';
import { MockSimRunner } from '@/worker/runner';
import { Timeline } from './Timeline';

// Stub uPlot: jsdom has no canvas, and we only assert the data plumbing.
const { MockUplot } = vi.hoisted(() => {
  class MockUplot {
    static instances: MockUplot[] = [];
    setData = vi.fn();
    setSize = vi.fn();
    destroy = vi.fn();
    constructor(
      public opts: unknown,
      public data: unknown,
      public target: unknown,
    ) {
      MockUplot.instances.push(this);
    }
  }
  return { MockUplot };
});
vi.mock('uplot', () => ({ default: MockUplot }));

let rafCb: FrameRequestCallback | null = null;

async function loadStore(): Promise<void> {
  useSimStore.setState(useSimStore.getInitialState(), true);
  useSimStore.getState().attach(new MockSimRunner());
  await useSimStore.getState().load();
}

describe('Timeline', () => {
  beforeEach(() => {
    MockUplot.instances.length = 0;
    rafCb = null;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCb = cb;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useSimStore.setState(useSimStore.getInitialState(), true);
  });

  it('does not create a plot before a run is loaded', () => {
    useSimStore.setState(useSimStore.getInitialState(), true);
    render(<Timeline kind="envoy" gauge="inFlight" />);
    expect(MockUplot.instances).toHaveLength(0);
  });

  it('creates a plot and feeds it series data on the animation frame', async () => {
    await loadStore();
    render(<Timeline kind="envoy" gauge="inFlight" />);
    expect(MockUplot.instances).toHaveLength(1);
    const plot = MockUplot.instances[0]!;
    // The seeded t=0 frame makes the ring non-empty; one draw pushes data.
    act(() => rafCb?.(0));
    expect(plot.setData).toHaveBeenCalledOnce();
    const data = plot.setData.mock.calls[0]![0] as number[][];
    expect(data).toHaveLength(1 + 4); // x + 4 envoys

    // A second frame with no new data is a no-op (hot-path change detection).
    act(() => rafCb?.(0));
    expect(plot.setData).toHaveBeenCalledOnce();
  });

  it('resizes on window resize and destroys on unmount', async () => {
    await loadStore();
    const { unmount } = render(<Timeline kind="backend" gauge="utilization" />);
    const plot = MockUplot.instances[0]!;
    act(() => window.dispatchEvent(new Event('resize')));
    expect(plot.setSize).toHaveBeenCalled();
    unmount();
    expect(plot.destroy).toHaveBeenCalledOnce();
  });
});
