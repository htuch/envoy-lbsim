import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { harnessScenario } from '@/components/harness/scenario';
import { makeTopologySnapshot } from '@/synthetic';
import { TopologyModal } from './TopologyModal';

const snapshot = makeTopologySnapshot(harnessScenario(), 1200);

describe('TopologyModal', () => {
  it('renders nothing when open is false', () => {
    const { container } = render(
      <TopologyModal
        open={false}
        snapshot={snapshot}
        onClose={() => {}}
        selectedEnvoy={0}
        onSelectEnvoy={() => {}}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the topology graph when open is true', () => {
    render(
      <TopologyModal
        open={true}
        snapshot={snapshot}
        onClose={() => {}}
        selectedEnvoy={0}
        onSelectEnvoy={() => {}}
      />,
    );
    expect(screen.getByText(`${snapshot.envoys.length} envoys`)).toBeInTheDocument();
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(
      <TopologyModal
        open={true}
        snapshot={snapshot}
        onClose={onClose}
        selectedEnvoy={0}
        onSelectEnvoy={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('forwards selectedEnvoy and onSelectEnvoy to the graph', () => {
    const onSelectEnvoy = vi.fn();
    render(
      <TopologyModal
        open={true}
        snapshot={snapshot}
        onClose={() => {}}
        selectedEnvoy={1}
        onSelectEnvoy={onSelectEnvoy}
      />,
    );
    // Click an Envoy node (e0 is not selected, e1 is).
    const e0 = screen.getByText('e0').closest('.react-flow__node');
    if (!(e0 instanceof HTMLElement)) throw new Error('e0 node not found');
    fireEvent.click(e0);
    expect(onSelectEnvoy).toHaveBeenCalledWith(0);
  });
});
