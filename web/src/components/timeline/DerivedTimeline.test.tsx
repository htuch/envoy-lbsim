import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Series } from '@/lib/series';
import { useSimStore } from '@/store/sim-store';
import { MockSimRunner } from '@/worker/runner';
import { DerivedTimeline } from './DerivedTimeline';

// Stub uPlot: jsdom has no canvas; we only assert the data + brush plumbing.
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

const LINES = [
  { label: 'a', stroke: '#111' },
  { label: 'b', stroke: '#222' },
];

let rafCb: FrameRequestCallback | null = null;

async function loadStore(): Promise<void> {
  useSimStore.setState(useSimStore.getInitialState(), true);
  useSimStore.getState().attach(new MockSimRunner());
  await useSimStore.getState().load();
}

describe('DerivedTimeline', () => {
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

  it('names and colors the series from the lines and feeds built data on a frame', async () => {
    await loadStore();
    // A builder with two non-empty curves over a 0..2s x axis.
    const build = (): Series => ({
      x: [0, 1, 2],
      ys: [
        [1, 2, 3],
        [4, 5, 6],
      ],
    });
    render(<DerivedTimeline lines={LINES} build={build} />);
    expect(MockUplot.instances).toHaveLength(1);
    const plot = MockUplot.instances[0]!;
    const opts = plot.opts as { series: { label?: string; stroke?: string }[] };
    expect(opts.series[1]).toMatchObject({ label: 'a', stroke: '#111' });
    expect(opts.series[2]).toMatchObject({ label: 'b', stroke: '#222' });

    act(() => rafCb?.(0));
    expect(plot.setData).toHaveBeenCalledOnce();
    const data = plot.setData.mock.calls[0]![0] as number[][];
    expect(data).toHaveLength(1 + 2); // x + two lines

    // A second frame with the same extent is a no-op (hot-path change detection).
    act(() => rafCb?.(0));
    expect(plot.setData).toHaveBeenCalledOnce();
  });

  it('redraws when the series grows', async () => {
    await loadStore();
    let n = 1;
    const build = (): Series => {
      const x = Array.from({ length: n }, (_, i) => i);
      return { x, ys: [x.map(() => 1), x.map(() => 2)] };
    };
    render(<DerivedTimeline lines={LINES} build={build} />);
    const plot = MockUplot.instances[0]!;
    act(() => rafCb?.(0));
    expect(plot.setData).toHaveBeenCalledOnce();
    n = 3;
    act(() => rafCb?.(0));
    expect(plot.setData).toHaveBeenCalledTimes(2);
  });

  it('commits a brushed window and clears the highlight on the next frame', async () => {
    await loadStore();
    const build = (): Series => ({
      x: [0, 1],
      ys: [
        [1, 2],
        [3, 4],
      ],
    });
    render(<DerivedTimeline lines={LINES} build={build} />);
    const plot = MockUplot.instances[0]!;
    plot.select = { left: 100, top: 0, width: 400, height: 50 };
    plot.posToVal = (px: number) => px / 100; // 100px -> 1s, 500px -> 5s
    act(() => plot.over.dispatchEvent(new MouseEvent('mouseup')));
    expect(useSimStore.getState().selection).toEqual({ fromMs: 1000, toMs: 5000 });
    expect(plot.setSelect).not.toHaveBeenCalled();
    act(() => rafCb?.(0));
    expect(plot.setSelect).toHaveBeenCalledWith({ left: 0, top: 0, width: 0, height: 0 }, false);
  });

  it('ignores a too-small drag (a stray click)', async () => {
    await loadStore();
    const build = (): Series => ({
      x: [0, 1],
      ys: [
        [1, 2],
        [3, 4],
      ],
    });
    render(<DerivedTimeline lines={LINES} build={build} />);
    const plot = MockUplot.instances[0]!;
    plot.select = { left: 100, top: 0, width: 2, height: 50 };
    act(() => plot.over.dispatchEvent(new MouseEvent('mouseup')));
    expect(useSimStore.getState().selection).toBeNull();
  });

  it('snaps the x scale in lock step when the shared selection changes', async () => {
    await loadStore();
    const build = (): Series => ({
      x: [0, 2],
      ys: [
        [1, 2],
        [3, 4],
      ],
    });
    render(<DerivedTimeline lines={LINES} build={build} />);
    const plot = MockUplot.instances[0]!;
    act(() => useSimStore.getState().setSelection({ fromMs: 1000, toMs: 2000 }));
    expect(plot.setScale).toHaveBeenCalledWith('x', { min: 1, max: 2 });
    // Clearing snaps back to the builder's data extent (0..2s).
    act(() => useSimStore.getState().setSelection(null));
    expect(plot.setScale).toHaveBeenLastCalledWith('x', { min: 0, max: 2 });
  });

  it('falls back to a unit window when the cleared extent is degenerate', async () => {
    await loadStore();
    // Single-sample builder: first === last, so the live extent is [t, t+1].
    const build = (): Series => ({ x: [3], ys: [[1], [2]] });
    render(<DerivedTimeline lines={LINES} build={build} />);
    const plot = MockUplot.instances[0]!;
    act(() => useSimStore.getState().setSelection({ fromMs: 0, toMs: 1000 }));
    act(() => useSimStore.getState().setSelection(null));
    expect(plot.setScale).toHaveBeenLastCalledWith('x', { min: 3, max: 4 });
  });

  it('does not snap when the cleared builder is empty', async () => {
    await loadStore();
    const build = (): Series => ({ x: [], ys: [[], []] });
    render(<DerivedTimeline lines={LINES} build={build} />);
    const plot = MockUplot.instances[0]!;
    act(() => useSimStore.getState().setSelection({ fromMs: 0, toMs: 1000 }));
    plot.setScale.mockClear();
    act(() => useSimStore.getState().setSelection(null));
    // No data to fit: applyView returns early, leaving the scale untouched.
    expect(plot.setScale).not.toHaveBeenCalled();
  });

  it('remounts the plot when the revision changes', async () => {
    await loadStore();
    const build = (): Series => ({
      x: [0, 1],
      ys: [
        [1, 2],
        [3, 4],
      ],
    });
    const { rerender } = render(<DerivedTimeline lines={LINES} build={build} revision={0} />);
    expect(MockUplot.instances).toHaveLength(1);
    rerender(<DerivedTimeline lines={LINES} build={build} revision={1} />);
    expect(MockUplot.instances).toHaveLength(2);
    expect(MockUplot.instances[0]!.destroy).toHaveBeenCalledOnce();
  });

  it('resizes on window resize and destroys on unmount', async () => {
    await loadStore();
    const build = (): Series => ({
      x: [0, 1],
      ys: [
        [1, 2],
        [3, 4],
      ],
    });
    const { unmount } = render(<DerivedTimeline lines={LINES} build={build} />);
    const plot = MockUplot.instances[0]!;
    act(() => window.dispatchEvent(new Event('resize')));
    expect(plot.setSize).toHaveBeenCalled();
    unmount();
    expect(plot.destroy).toHaveBeenCalledOnce();
  });
});
