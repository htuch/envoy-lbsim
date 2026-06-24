import { fireEvent, render, screen } from '@testing-library/react';
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

describe('App shell', () => {
  beforeEach(async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    useSimStore.setState(useSimStore.getInitialState(), true);
    useSimStore.getState().attach(new MockSimRunner());
    await useSimStore.getState().load();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useSimStore.setState(useSimStore.getInitialState(), true);
  });

  it('renders the title, status, editor, timelines, and transport', () => {
    render(<App />);
    expect(screen.getByText('Envoy LB Simulator')).toBeInTheDocument();
    // Header status reflects the active policy and playback state.
    expect(screen.getByText('maglev · paused')).toBeInTheDocument();
    // Config editor (left), a timeline strip (center), and transport (bottom).
    expect(screen.getByLabelText('Seed')).toBeInTheDocument();
    expect(screen.getByText('Envoy · in-flight')).toBeInTheDocument();
    expect(screen.getByLabelText('Play')).toBeInTheDocument();
  });

  it('switches the visualization surface between timelines and the analytical views', () => {
    render(<App />);
    // Default view is the live timelines.
    expect(screen.getByText('Envoy · in-flight')).toBeInTheDocument();

    // Switching to an analytical view replaces the timeline strips with it; the
    // config editor and transport (the shell) stay mounted throughout.
    for (const label of ['Topology', 'Analysis', 'Inspector']) {
      fireEvent.click(screen.getByRole('radio', { name: label }));
      expect(screen.queryByText('Envoy · in-flight')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Seed')).toBeInTheDocument();
      expect(screen.getByLabelText('Play')).toBeInTheDocument();
    }

    // And back to the live timelines.
    fireEvent.click(screen.getByRole('radio', { name: 'Timelines' }));
    expect(screen.getByText('Envoy · in-flight')).toBeInTheDocument();
  });
});
