import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSimStore } from '@/store/sim-store';
import { MockSimRunner } from '@/worker/runner';
import { App } from './App';

const { MockUplot } = vi.hoisted(() => {
  class MockUplot {
    setData = vi.fn();
    setSize = vi.fn();
    destroy = vi.fn();
    redraw = vi.fn();
    setScale = vi.fn();
    setSelect = vi.fn();
    posToVal = (pos: number): number => pos;
    select = { left: 0, top: 0, width: 0, height: 0 };
    over = document.createElement('div');
    constructor(
      public opts: unknown,
      public data: unknown,
      public target: unknown,
    ) {}
  }
  return { MockUplot };
});
vi.mock('uplot', () => ({ default: MockUplot }));

let rafCbs: FrameRequestCallback[] = [];

describe('App cockpit shell', () => {
  beforeEach(async () => {
    rafCbs = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCbs.push(cb);
      return rafCbs.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    useSimStore.setState(useSimStore.getInitialState(), true);
    useSimStore.getState().attach(new MockSimRunner());
    await useSimStore.getState().load();
    // The Dock (now a permanent cockpit column) fetches an LB inspection on
    // mount, but the synthetic MockSimRunner has no LB structures to serialize
    // and throws. Stub the cold-path store actions to resolve so the shell test
    // exercises layout/wiring, not the (separately tested) dock data path.
    useSimStore.setState({
      loadInspection: vi.fn().mockResolvedValue(undefined) as unknown as (
        envoy: number,
        tMs: number,
      ) => Promise<void>,
      loadWindow: vi.fn().mockResolvedValue(undefined) as unknown as (
        q: Parameters<ReturnType<typeof useSimStore.getState>['loadWindow']>[0],
      ) => Promise<void>,
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useSimStore.setState(useSimStore.getInitialState(), true);
  });

  it('renders the title, status, editor, and transport', () => {
    render(<App />);
    expect(screen.getByText('Envoy LB Simulator')).toBeInTheDocument();
    // Header status reflects the active policy and playback state.
    expect(screen.getByText('maglev · paused')).toBeInTheDocument();
    // Config editor (left rail) and transport (top bar) are part of the shell.
    expect(screen.getByLabelText('Seed')).toBeInTheDocument();
    expect(screen.getByLabelText('Play')).toBeInTheDocument();
  });

  it('drops the tabbed view switcher entirely', () => {
    render(<App />);
    // No Segmented visualization switcher: the analytical views moved into the
    // pinned heatmap / topology modal / dock, so there are no radio tabs gating
    // the cockpit surface.
    expect(screen.queryByRole('radio', { name: 'Timelines' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Analysis' })).not.toBeInTheDocument();
  });

  it('renders the heatmap, the full strip stack, and the dock simultaneously', () => {
    render(<App />);

    // Fleet heatmap (pinned band): tier rows are present and not tab-gated.
    expect(document.querySelector('[data-tier="envoys"]')).toBeInTheDocument();
    expect(document.querySelector('[data-tier="backends"]')).toBeInTheDocument();

    // The per-entity gauge strips.
    expect(screen.getByText('Envoy · in-flight')).toBeInTheDocument();
    expect(screen.getByText('Backend · utilization')).toBeInTheDocument();
    expect(screen.getByText('Client · emit rate')).toBeInTheDocument();

    // The derived strips (selected-envoy latency, fleet goodput, per-stage
    // losses). The latency strip names the currently selected envoy.
    expect(screen.getByText('Envoy · latency · e0')).toBeInTheDocument();
    expect(screen.getByText('Fleet · goodput')).toBeInTheDocument();
    expect(screen.getByText('Fleet · losses by stage')).toBeInTheDocument();

    // The dock (right column) renders alongside everything else; its resize
    // divider is a stable structural marker.
    expect(screen.getByLabelText('Resize dock')).toBeInTheDocument();
  });

  it('opens the topology modal from the heatmap expand control', () => {
    render(<App />);
    expect(screen.queryByRole('dialog', { name: 'Topology graph' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Open topology graph'));
    expect(screen.getByRole('dialog', { name: 'Topology graph' })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Close topology'));
    expect(screen.queryByRole('dialog', { name: 'Topology graph' })).not.toBeInTheDocument();
  });

  it('selects an envoy from the heatmap, driving the shared store selection', () => {
    render(<App />);
    // Default config has 4 envoys (e0..e3); clicking e2 updates the store so the
    // dock inspector and the selected-latency strip follow.
    fireEvent.click(screen.getByRole('button', { name: /^e2/ }));
    expect(useSimStore.getState().selectedEnvoy).toBe(2);
  });

  it('feeds the derived strips by running their builders on an animation frame', () => {
    render(<App />);
    // Every strip (gauge + derived) registered a draw callback. Driving one
    // frame runs all of them, exercising the goodput/loss/latency builders off
    // the seeded rings without throwing.
    expect(rafCbs.length).toBeGreaterThan(0);
    // Snapshot the queue: each draw re-arms itself via requestAnimationFrame, so
    // iterating the live array would never terminate. One frame per strip is
    // enough to run every builder once.
    const frame = [...rafCbs];
    act(() => {
      for (const cb of frame) cb(0);
    });
    // The selected-envoy latency strip follows the store selection: selecting a
    // new envoy renames it and (via the revision remount) re-reads that envoy.
    fireEvent.click(screen.getByRole('button', { name: /^e1/ }));
    expect(screen.getByText('Envoy · latency · e1')).toBeInTheDocument();
  });

  it('shows the empty-fleet placeholder before any run is loaded', () => {
    // A fresh, unloaded store (no rings): the heatmap band falls back to the
    // load prompt rather than rendering tier rows.
    useSimStore.setState(useSimStore.getInitialState(), true);
    render(<App />);
    expect(screen.getByText('Load a config to populate the fleet.')).toBeInTheDocument();
    expect(document.querySelector('[data-tier="envoys"]')).not.toBeInTheDocument();
  });
});
