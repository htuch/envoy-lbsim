import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { harnessScenario } from '@/components/harness/scenario';
import { makeTopologySnapshot } from '@/synthetic';
import { TopologyGraph } from './TopologyGraph';

const snapshot = makeTopologySnapshot(harnessScenario(), 1200);

function nodeElement(label: string): HTMLElement {
  const el = screen.getByText(label).closest('.react-flow__node');
  if (!(el instanceof HTMLElement)) throw new Error(`no node element for ${label}`);
  return el;
}

describe('TopologyGraph', () => {
  it('renders the scenario legend and entity labels', () => {
    render(<TopologyGraph snapshot={snapshot} selectedEnvoy={0} onSelectEnvoy={() => {}} />);
    expect(screen.getByText(`${snapshot.envoys.length} envoys`)).toBeInTheDocument();
    expect(screen.getByText('e0')).toBeInTheDocument();
    expect(screen.getByText('b0')).toBeInTheDocument();
  });

  it('selects the Envoy on node click', () => {
    const onSelect = vi.fn();
    render(<TopologyGraph snapshot={snapshot} selectedEnvoy={0} onSelectEnvoy={onSelect} />);
    fireEvent.click(nodeElement('e1'));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('ignores clicks on non-Envoy nodes', () => {
    const onSelect = vi.fn();
    render(<TopologyGraph snapshot={snapshot} selectedEnvoy={0} onSelectEnvoy={onSelect} />);
    fireEvent.click(nodeElement('b0'));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
