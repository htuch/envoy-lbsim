import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSimStore } from '@/store/sim-store';
import { MockSimRunner } from '@/worker/runner';
import { TimelineStrip } from './TimelineStrip';

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

async function loadStore(): Promise<void> {
  useSimStore.setState(useSimStore.getInitialState(), true);
  useSimStore.getState().attach(new MockSimRunner());
  await useSimStore.getState().load();
}

describe('TimelineStrip', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useSimStore.setState(useSimStore.getInitialState(), true);
  });

  it('shows the gauge label and a legend swatch per entity', async () => {
    await loadStore();
    render(<TimelineStrip kind="envoy" gauge="inFlight" label="Envoy · in-flight" unit="reqs" />);
    expect(screen.getByText('Envoy · in-flight')).toBeInTheDocument();
    // Four envoys in the default scenario.
    expect(screen.getByText('#0')).toBeInTheDocument();
    expect(screen.getByText('#3')).toBeInTheDocument();
    expect(screen.queryByText('#4')).not.toBeInTheDocument();
  });

  it('renders the strip unit in the header', async () => {
    await loadStore();
    render(<TimelineStrip kind="envoy" gauge="inFlight" label="Envoy · in-flight" unit="reqs" />);
    expect(screen.getByText('reqs')).toBeInTheDocument();
  });

  it('caps the legend and shows an overflow count for dense fleets', async () => {
    await loadStore();
    render(
      <TimelineStrip kind="client" gauge="emitRate" label="Client · emit rate" unit="req/s" />,
    );
    // 50 clients, legend capped at 8 → "+42".
    expect(screen.getByText('#7')).toBeInTheDocument();
    expect(screen.queryByText('#8')).not.toBeInTheDocument();
    expect(screen.getByText('+42')).toBeInTheDocument();
  });

  it('renders the strip unit as req/s for emitRate', async () => {
    await loadStore();
    render(
      <TimelineStrip kind="client" gauge="emitRate" label="Client · emit rate" unit="req/s" />,
    );
    expect(screen.getByText('req/s')).toBeInTheDocument();
  });
});
