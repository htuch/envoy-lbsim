import {
  Background,
  BackgroundVariant,
  Controls,
  type Node,
  Panel,
  ReactFlow,
} from '@xyflow/react';
import { useCallback, useMemo } from 'react';
import type { TopologySnapshot } from '@/synthetic';
import '@xyflow/react/dist/style.css';
import { EntityNode } from './EntityNode';
import { type EntityNode as EntityNodeType, layoutTopology } from './layout';

/** Module-level so React Flow does not warn about a new object each render. */
const nodeTypes = { entity: EntityNode };

interface TopologyGraphProps {
  snapshot: TopologySnapshot;
  /** Currently inspected Envoy, highlighted in the graph. */
  selectedEnvoy: number;
  /** Called when an Envoy node is clicked, to drive the inspector. */
  onSelectEnvoy: (index: number) => void;
}

/**
 * Read-only topology graph: clients -> Envoys -> backends, laid out
 * left-to-right with live per-node status. Clicking an Envoy selects it for the
 * inspector. The hot-path data (Track B) replaces the synthetic snapshot; this
 * view is otherwise unchanged.
 */
export function TopologyGraph({
  snapshot,
  selectedEnvoy,
  onSelectEnvoy,
}: TopologyGraphProps): React.JSX.Element {
  const layout = useMemo(() => layoutTopology(snapshot), [snapshot]);

  const nodes = useMemo(
    () =>
      layout.nodes.map((n) => ({
        ...n,
        selected: n.data.status.kind === 'envoy' && n.data.status.index === selectedEnvoy,
      })),
    [layout.nodes, selectedEnvoy],
  );

  const handleNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      const status = (node as EntityNodeType).data.status;
      if (status.kind === 'envoy') onSelectEnvoy(status.index);
    },
    [onSelectEnvoy],
  );

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={layout.edges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        nodesDraggable={false}
        nodesConnectable={false}
        fitView
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
        <Controls showInteractive={false} />
        <Panel position="top-left">
          <div className="flex items-center gap-3 rounded-md border bg-card/90 px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground shadow-sm backdrop-blur">
            <span>{snapshot.clients.length} clients</span>
            <span>{snapshot.envoys.length} envoys</span>
            <span>{snapshot.backends.length} backends</span>
          </div>
        </Panel>
      </ReactFlow>
    </div>
  );
}
