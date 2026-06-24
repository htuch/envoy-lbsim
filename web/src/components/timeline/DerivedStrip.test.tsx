import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Series } from '@/lib/series';
import { DerivedStrip } from './DerivedStrip';

// Stub uPlot: jsdom has no canvas, and the strip only needs to mount its header.
const { MockUplot } = vi.hoisted(() => {
  class MockUplot {
    setData = vi.fn();
    setSize = vi.fn();
    destroy = vi.fn();
    setScale = vi.fn();
    setSelect = vi.fn();
    posToVal = (pos: number): number => pos;
    select = { left: 0, top: 0, width: 0, height: 0 };
    cursor = { left: 0 };
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

const LINES = [{ label: 'p99', stroke: '#111' }];
const build = (): Series => ({ x: [], ys: [[]] });

describe('DerivedStrip', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the label, a named legend swatch, and the unit', () => {
    render(<DerivedStrip label="Fleet · goodput" unit="ratio 0-1" lines={LINES} build={build} />);
    expect(screen.getByText('Fleet · goodput')).toBeInTheDocument();
    expect(screen.getByText('p99')).toBeInTheDocument();
    expect(screen.getByText('ratio 0-1')).toBeInTheDocument();
  });
});
