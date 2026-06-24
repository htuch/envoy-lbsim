import { render, screen } from '@testing-library/react';
import { type NodeProps, ReactFlowProvider } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { EntityNode } from './EntityNode';
import type { EntityNode as EntityNodeType } from './layout';
import type { TopologyNodeStatus } from './types';

function status(partial: Partial<TopologyNodeStatus>): TopologyNodeStatus {
  return {
    kind: 'backend',
    index: 0,
    label: 'b0',
    inFlight: 5,
    queueDepth: 3,
    queueCapacity: 48,
    utilization: 0.5,
    health: 0,
    panic: false,
    region: 'r1',
    zone: 'z1',
    ...partial,
  };
}

function renderNode(s: TopologyNodeStatus, selected = false) {
  const props = { data: { status: s }, selected } as unknown as NodeProps<EntityNodeType>;
  return render(
    <ReactFlowProvider>
      <EntityNode {...props} />
    </ReactFlowProvider>,
  );
}

describe('EntityNode', () => {
  it('renders a backend with load and queue bars', () => {
    renderNode(status({ kind: 'backend', label: 'b2', inFlight: 7 }));
    expect(screen.getByText('b2')).toBeInTheDocument();
    expect(screen.getByText('in-flight')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('queue')).toBeInTheDocument();
    expect(screen.getByText('3/48')).toBeInTheDocument();
    expect(screen.getByText('healthy')).toBeInTheDocument();
  });

  it('omits load and queue for a client', () => {
    renderNode(status({ kind: 'client', label: 'c1', queueCapacity: 0 }));
    expect(screen.getByText('c1')).toBeInTheDocument();
    expect(screen.queryByText('in-flight')).not.toBeInTheDocument();
    expect(screen.queryByText('queue')).not.toBeInTheDocument();
  });

  it('flags Envoy panic', () => {
    renderNode(status({ kind: 'envoy', label: 'e0', panic: true }));
    expect(screen.getByText('panic')).toBeInTheDocument();
  });

  it('shows a selection ring when selected', () => {
    const { container } = renderNode(status({ kind: 'envoy', label: 'e1' }), true);
    expect(container.querySelector('.ring-2')).not.toBeNull();
  });
});
