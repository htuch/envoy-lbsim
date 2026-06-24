import dagre from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';
import type { TopologyNodeStatus, TopologySnapshot } from '@/synthetic';

/**
 * Pure topology layout: turn a {@link TopologySnapshot} into positioned React
 * Flow nodes and edges via a left-to-right dagre layout. Separated from the view
 * so the graph structure (node ids, ranks, edge weighting) is unit-testable
 * without rendering.
 */

/** Node data carried to the custom React Flow node renderer. */
export interface EntityNodeData extends Record<string, unknown> {
  status: TopologyNodeStatus;
}

export type EntityNode = Node<EntityNodeData, 'entity'>;

/** Per-kind node footprint (px), also used by dagre for spacing. */
const NODE_SIZE: Record<TopologyNodeStatus['kind'], { width: number; height: number }> = {
  client: { width: 92, height: 44 },
  envoy: { width: 132, height: 64 },
  backend: { width: 120, height: 64 },
};

/** Stable React Flow node id for an entity. */
export function nodeId(kind: TopologyNodeStatus['kind'], index: number): string {
  return `${kind}-${index}`;
}

export interface TopologyLayout {
  nodes: EntityNode[];
  edges: Edge[];
}

/** Build positioned nodes and weighted edges for a snapshot. */
export function layoutTopology(snapshot: TopologySnapshot): TopologyLayout {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', ranksep: 110, nodesep: 18, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));

  const statuses = [...snapshot.clients, ...snapshot.envoys, ...snapshot.backends];
  for (const status of statuses) {
    const size = NODE_SIZE[status.kind];
    g.setNode(nodeId(status.kind, status.index), { ...size });
  }
  for (const edge of snapshot.edges) {
    g.setEdge(nodeId(edge.fromKind, edge.fromIndex), nodeId(edge.toKind, edge.toIndex));
  }
  dagre.layout(g);

  const nodes: EntityNode[] = statuses.map((status) => {
    const id = nodeId(status.kind, status.index);
    const { x, y } = g.node(id);
    const size = NODE_SIZE[status.kind];
    return {
      id,
      type: 'entity',
      // dagre reports node centers; React Flow positions by top-left corner.
      position: { x: x - size.width / 2, y: y - size.height / 2 },
      data: { status },
      draggable: false,
      connectable: false,
      selectable: status.kind === 'envoy',
    };
  });

  const edges: Edge[] = snapshot.edges.map((edge) => {
    const source = nodeId(edge.fromKind, edge.fromIndex);
    const target = nodeId(edge.toKind, edge.toIndex);
    const fromClient = edge.fromKind === 'client';
    return {
      id: `${source}->${target}`,
      source,
      target,
      // Weight the envoy->backend stroke by traffic share; the dense client
      // fan-out stays thin but legible. muted-foreground reads clearly against
      // the canvas (the near-white border color did not).
      style: {
        strokeWidth: fromClient ? 1 : 1 + edge.share * 4,
        stroke: 'var(--color-muted-foreground)',
        opacity: fromClient ? 0.4 : 0.65,
      },
    };
  });

  return { nodes, edges };
}
