import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSimStore } from '@/store/sim-store';
import { MockSimRunner } from '@/worker/runner';
import { Timeline } from './Timeline';

// Stub uPlot: jsdom has no canvas, and we only assert the data + brush plumbing.
const { MockUplot } = vi.hoisted(() => {
  class MockUplot {
    static instances: MockUplot[] = [];
    setData = vi.fn();
    setSize = vi.fn();
    destroy = vi.fn();
    redraw = vi.fn();
    setScale = vi.fn();
    setSelect = vi.fn();
    posToVal = (pos: number): number => pos / 100;
    select = { left: 0, top: 0, width: 0, height: 0 };
    cursor = { left: 0 };
    over = document.createElement('div');
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

  it('commits a brushed window and clears the highlight on the next frame', async () => {
    await loadStore();
    render(<Timeline kind="envoy" gauge="inFlight" />);
    const plot = MockUplot.instances[0]!;
    plot.select = { left: 100, top: 0, width: 400, height: 50 };
    plot.posToVal = (px: number) => px / 100; // 100px → 1s, 500px → 5s
    act(() => plot.over.dispatchEvent(new MouseEvent('mouseup')));
    expect(useSimStore.getState().selection).toEqual({ fromMs: 1000, toMs: 5000 });
    // The highlight is cleared on the next animation frame, not synchronously,
    // so it stays visible through uPlot's own mouseup handling during the drag.
    expect(plot.setSelect).not.toHaveBeenCalled();
    act(() => rafCb?.(0));
    expect(plot.setSelect).toHaveBeenCalledWith({ left: 0, top: 0, width: 0, height: 0 }, false);
  });

  it('ignores a too-small drag (a stray click)', async () => {
    await loadStore();
    render(<Timeline kind="backend" gauge="utilization" />);
    const plot = MockUplot.instances[0]!;
    plot.select = { left: 100, top: 0, width: 2, height: 50 };
    act(() => plot.over.dispatchEvent(new MouseEvent('mouseup')));
    expect(useSimStore.getState().selection).toBeNull();
  });

  it('seeks to the clicked virtual time on a plain click (not a drag)', async () => {
    await loadStore();
    const seekSpy = vi.fn().mockResolvedValue(undefined);
    useSimStore.setState({ seek: seekSpy as unknown as (tMs: number) => Promise<void> });
    render(<Timeline kind="envoy" gauge="inFlight" />);
    const plot = MockUplot.instances[0]!;
    // No drag region (width 0) => a plain click. cursor at 300px => 3s => 3000ms.
    plot.select = { left: 0, top: 0, width: 0, height: 0 };
    plot.cursor = { left: 300 };
    act(() => plot.over.dispatchEvent(new MouseEvent('click')));
    expect(seekSpy).toHaveBeenCalledWith(3000);
  });

  it('does not seek when the gesture was a brush-drag', async () => {
    await loadStore();
    const seekSpy = vi.fn().mockResolvedValue(undefined);
    useSimStore.setState({ seek: seekSpy as unknown as (tMs: number) => Promise<void> });
    render(<Timeline kind="envoy" gauge="inFlight" />);
    const plot = MockUplot.instances[0]!;
    // A committed drag region (width over the threshold) is a brush, not a seek.
    plot.select = { left: 100, top: 0, width: 400, height: 50 };
    plot.cursor = { left: 500 };
    act(() => plot.over.dispatchEvent(new MouseEvent('click')));
    expect(seekSpy).not.toHaveBeenCalled();
  });

  it('snaps the x scale in lock step when the shared selection changes', async () => {
    await loadStore();
    render(<Timeline kind="envoy" gauge="inFlight" />);
    const plot = MockUplot.instances[0]!;
    act(() => useSimStore.getState().setSelection({ fromMs: 1000, toMs: 2000 }));
    expect(plot.setScale).toHaveBeenCalledWith('x', { min: 1, max: 2 });
    // Clearing the selection snaps back to the live data extent (seeded t=0 frame).
    act(() => useSimStore.getState().setSelection(null));
    expect(plot.setScale).toHaveBeenLastCalledWith('x', { min: 0, max: 1 });
  });

  it('pins the x scale to the shared window via the range fn', async () => {
    await loadStore();
    render(<Timeline kind="envoy" gauge="inFlight" />);
    const opts = MockUplot.instances[0]!.opts as {
      scales: { x: { range: (u: unknown, a: number, b: number) => [number, number] } };
    };
    const range = opts.scales.x.range;
    expect(range({}, 0, 30)).toEqual([0, 30]); // no selection → data extent
    act(() => useSimStore.getState().setSelection({ fromMs: 1000, toMs: 5000 }));
    expect(range({}, 0, 30)).toEqual([1, 5]); // selection → frozen window (seconds)
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
