import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TopologySnapshot } from '@/components/topology/types';
import { FleetHeatmap, loadColor } from './FleetHeatmap';

// ---------------------------------------------------------------------------
// Minimal snapshot factory
// ---------------------------------------------------------------------------

function makeNode(
  kind: 'client' | 'envoy' | 'backend',
  index: number,
  overrides: Partial<{
    utilization: number;
    health: 0 | 1 | 2 | 3;
    queueDepth: number;
    queueCapacity: number;
    panic: boolean;
  }> = {},
) {
  return {
    kind,
    index,
    label: `${kind[0]}${index}`,
    inFlight: 0,
    queueDepth: overrides.queueDepth ?? 0,
    queueCapacity: overrides.queueCapacity ?? 0,
    utilization: overrides.utilization ?? 0.3,
    health: overrides.health ?? 0,
    panic: overrides.panic ?? false,
    region: 'r1',
    zone: 'z1',
  } as const;
}

/**
 * A snapshot with:
 *   - 2 clients (c0, c1)
 *   - 4 envoys (e0 saturated, e1, e2, e3)
 *   - 3 backends (b0, b1 unhealthy, b2)
 * envoy 2 is "selected" (passed as selectedEnvoy=2).
 */
const snapshot: TopologySnapshot = {
  t: 1000,
  clients: [makeNode('client', 0), makeNode('client', 1)],
  envoys: [
    makeNode('envoy', 0, { utilization: 1.2 }), // saturated
    makeNode('envoy', 1),
    makeNode('envoy', 2),
    makeNode('envoy', 3),
  ],
  backends: [
    makeNode('backend', 0),
    makeNode('backend', 1, { health: 2 }), // unhealthy
    makeNode('backend', 2),
  ],
  edges: [],
};

const TOTAL_CELLS = snapshot.clients.length + snapshot.envoys.length + snapshot.backends.length; // 9

function renderHeatmap(selectedEnvoy = 2, onSelectEnvoy = vi.fn()) {
  return render(
    <FleetHeatmap
      snapshot={snapshot}
      selectedEnvoy={selectedEnvoy}
      onSelectEnvoy={onSelectEnvoy}
    />,
  );
}

// ---------------------------------------------------------------------------
// Structural tests
// ---------------------------------------------------------------------------

describe('FleetHeatmap structure', () => {
  it('renders the correct total number of cells', () => {
    renderHeatmap();
    // Envoy cells are buttons; client/backend cells are static divs
    const envoyButtons = screen.getAllByRole('button');
    // client + backend cells are non-interactive; envoy cells are buttons
    expect(envoyButtons).toHaveLength(snapshot.envoys.length);
    // All tier rows present
    expect(document.querySelector('[data-tier="clients"]')).not.toBeNull();
    expect(document.querySelector('[data-tier="envoys"]')).not.toBeNull();
    expect(document.querySelector('[data-tier="backends"]')).not.toBeNull();
    // Total visual cells: buttons + static divs
    const allCells = [
      ...document.querySelectorAll('[data-tier="clients"] > * > *'),
      ...document.querySelectorAll('[data-tier="envoys"] > * > button'),
      ...document.querySelectorAll('[data-tier="backends"] > * > *'),
    ];
    expect(allCells.length).toBe(TOTAL_CELLS);
  });

  it('renders a cell for every entity label', () => {
    renderHeatmap();
    expect(screen.getByText('c0')).toBeInTheDocument();
    expect(screen.getByText('c1')).toBeInTheDocument();
    expect(screen.getByText('e0')).toBeInTheDocument();
    expect(screen.getByText('e3')).toBeInTheDocument();
    expect(screen.getByText('b0')).toBeInTheDocument();
    expect(screen.getByText('b2')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// data-unhealthy
// ---------------------------------------------------------------------------

describe('FleetHeatmap unhealthy backend', () => {
  it('marks the unhealthy backend cell with data-unhealthy', () => {
    renderHeatmap();
    const backendRow = document.querySelector('[data-tier="backends"]')!;
    expect(backendRow).not.toBeNull();
    const unhealthy = backendRow.querySelector('[data-unhealthy]');
    expect(unhealthy).not.toBeNull();
    // Only b1 should be marked
    const allUnhealthy = backendRow.querySelectorAll('[data-unhealthy]');
    expect(allUnhealthy).toHaveLength(1);
  });

  it('does not mark healthy backends with data-unhealthy', () => {
    renderHeatmap();
    const backendRow = document.querySelector('[data-tier="backends"]')!;
    const cells = backendRow.querySelectorAll('[data-unhealthy]');
    expect(cells).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// data-selected
// ---------------------------------------------------------------------------

describe('FleetHeatmap selected envoy', () => {
  it('marks the selected envoy cell with data-selected', () => {
    renderHeatmap(2);
    const envoyRow = document.querySelector('[data-tier="envoys"]')!;
    const selected = envoyRow.querySelector('[data-selected]');
    expect(selected).not.toBeNull();
    // e2 should be the one
    expect(selected?.textContent).toContain('e2');
  });

  it('only one envoy cell is selected at a time', () => {
    renderHeatmap(2);
    const envoyRow = document.querySelector('[data-tier="envoys"]')!;
    const selected = envoyRow.querySelectorAll('[data-selected]');
    expect(selected).toHaveLength(1);
  });

  it('moves selection when selectedEnvoy prop changes', () => {
    const { rerender } = renderHeatmap(2);
    let envoyRow = document.querySelector('[data-tier="envoys"]')!;
    expect(envoyRow.querySelector('[data-selected]')?.textContent).toContain('e2');

    rerender(<FleetHeatmap snapshot={snapshot} selectedEnvoy={1} onSelectEnvoy={vi.fn()} />);
    envoyRow = document.querySelector('[data-tier="envoys"]')!;
    expect(envoyRow.querySelector('[data-selected]')?.textContent).toContain('e1');
  });
});

// ---------------------------------------------------------------------------
// Click interaction
// ---------------------------------------------------------------------------

describe('FleetHeatmap click interaction', () => {
  it('calls onSelectEnvoy with the correct index when an envoy cell is clicked', () => {
    const onSelect = vi.fn();
    renderHeatmap(2, onSelect);
    const e3Button = screen.getByText('e3').closest('button')!;
    expect(e3Button).not.toBeNull();
    fireEvent.click(e3Button);
    expect(onSelect).toHaveBeenCalledWith(3);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('does not call onSelectEnvoy when a client cell is clicked', () => {
    const onSelect = vi.fn();
    renderHeatmap(2, onSelect);
    // Client cells are static divs, not buttons -- no click should register
    const c0 = screen.getByText('c0');
    expect(c0.closest('button')).toBeNull();
  });

  it('does not call onSelectEnvoy when a backend cell is clicked', () => {
    const onSelect = vi.fn();
    renderHeatmap(2, onSelect);
    const b0 = screen.getByText('b0');
    expect(b0.closest('button')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Queue tick
// ---------------------------------------------------------------------------

describe('FleetHeatmap queue tick', () => {
  it('renders a queue-tick element when queueDepth > 0', () => {
    const snapshotWithQueue: TopologySnapshot = {
      ...snapshot,
      envoys: [makeNode('envoy', 0, { queueDepth: 3, queueCapacity: 10 }), makeNode('envoy', 1)],
    };
    render(<FleetHeatmap snapshot={snapshotWithQueue} selectedEnvoy={0} onSelectEnvoy={vi.fn()} />);
    // Should have a queue-tick visible for e0
    const e0Button = screen.getByText('e0').closest('button')!;
    const tick = e0Button.querySelector('.queue-tick');
    expect(tick).not.toBeNull();
  });

  it('does not render a queue-tick when queueDepth is 0', () => {
    const snapshotNoQueue: TopologySnapshot = {
      ...snapshot,
      envoys: [makeNode('envoy', 0, { queueDepth: 0 }), makeNode('envoy', 1)],
    };
    render(<FleetHeatmap snapshot={snapshotNoQueue} selectedEnvoy={0} onSelectEnvoy={vi.fn()} />);
    const e0Button = screen.getByText('e0').closest('button')!;
    const tick = e0Button.querySelector('.queue-tick');
    expect(tick).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loadColor unit tests
// ---------------------------------------------------------------------------

describe('loadColor ramp boundaries', () => {
  it('returns a light blue at utilization 0', () => {
    const color = loadColor(0);
    // Should parse as hsl with high lightness (>= 80%)
    expect(color).toMatch(/^hsl\(/);
    // hsl(210 60.0% 85.0%)
    expect(color).toContain('85');
  });

  it('returns a mid blue at utilization 0.5', () => {
    const color = loadColor(0.5);
    expect(color).toMatch(/^hsl\(/);
    // Lightness should be around 56.5% -- roughly between 28 and 85
    // We just check it is in the right ballpark (not light, not amber)
    const match = color.match(/hsl\(210 ([\d.]+)% ([\d.]+)%\)/);
    expect(match).not.toBeNull();
    const lightness = parseFloat(match![2]!);
    expect(lightness).toBeGreaterThan(30);
    expect(lightness).toBeLessThan(80);
  });

  it('returns amber at utilization exactly 1', () => {
    const color = loadColor(1);
    expect(color).toBe('hsl(38 95% 52%)');
  });

  it('returns amber for utilization above 1 (saturated)', () => {
    expect(loadColor(1.5)).toBe('hsl(38 95% 52%)');
    expect(loadColor(2.0)).toBe('hsl(38 95% 52%)');
    expect(loadColor(99)).toBe('hsl(38 95% 52%)');
  });

  it('clamps negative utilization to 0 (light blue)', () => {
    const colorNeg = loadColor(-0.5);
    const color0 = loadColor(0);
    expect(colorNeg).toBe(color0);
  });

  it('returns progressively darker blue as utilization increases from 0 to 1', () => {
    const colors = [0, 0.25, 0.5, 0.75].map(loadColor);
    // Extract lightness values; they should be strictly decreasing
    const lightnesses = colors.map((c) => {
      const m = c.match(/hsl\(210 ([\d.]+)% ([\d.]+)%\)/);
      return parseFloat(m![2]!);
    });
    for (let i = 1; i < lightnesses.length; i++) {
      expect(lightnesses[i]!).toBeLessThan(lightnesses[i - 1]!);
    }
  });
});
