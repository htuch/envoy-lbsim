import { X } from 'lucide-react';
import { TopologyGraph } from './TopologyGraph';
import type { TopologySnapshot } from './types';

interface TopologyModalProps {
  open: boolean;
  snapshot: TopologySnapshot;
  onClose: () => void;
  selectedEnvoy: number | null;
  onSelectEnvoy: (index: number | null) => void;
}

/**
 * Full-screen overlay that renders the DAGRE topology graph. Clicking an Envoy
 * node drives the same `onSelectEnvoy` callback as the inline graph, so
 * selection is shared with the dock. Returns null when closed to avoid mounting
 * React Flow when invisible.
 */
export function TopologyModal({
  open,
  snapshot,
  onClose,
  selectedEnvoy,
  onSelectEnvoy,
}: TopologyModalProps): React.JSX.Element | null {
  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Topology graph"
      className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm"
    >
      {/* Header bar */}
      <div className="flex shrink-0 items-center justify-between border-b bg-card/80 px-4 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Topology
        </span>
        <button
          type="button"
          aria-label="Close topology"
          onClick={onClose}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X size={16} />
        </button>
      </div>

      {/* Graph fills the remaining space */}
      <div className="min-h-0 flex-1">
        <TopologyGraph
          snapshot={snapshot}
          selectedEnvoy={selectedEnvoy}
          onSelectEnvoy={onSelectEnvoy}
        />
      </div>
    </div>
  );
}
