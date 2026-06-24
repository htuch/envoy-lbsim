import type { TopologyNodeStatus, TopologySnapshot } from '@/components/topology/types';
import { cn } from '@/lib/utils';

// ─── Load color ramp ──────────────────────────────────────────────────────────

/**
 * Maps utilization to a sequential light-blue → navy ramp, clamping to amber
 * when the node is saturated (utilization >= 1).
 *
 *   0.0  → hsl(210 60% 85%)   light ice-blue
 *   0.5  → hsl(210 80% 45%)   mid cobalt
 *   1.0+ → hsl(38  95% 52%)   amber (saturation)
 */
export function loadColor(utilization: number): string {
  if (utilization >= 1) return 'hsl(38 95% 52%)';

  const u = Math.max(0, utilization);

  // Lightness: 85% → 28% as u goes 0 → 1
  const lightness = 85 - 57 * u;
  // Saturation: 60% → 90% as u goes 0 → 1
  const saturation = 60 + 30 * u;
  // Hue stays at 210 (blue) the whole way
  return `hsl(210 ${saturation.toFixed(1)}% ${lightness.toFixed(1)}%)`;
}

// ─── Cell components ──────────────────────────────────────────────────────────

interface CellProps {
  node: TopologyNodeStatus;
  isSelected?: boolean;
  isUnhealthy?: boolean;
  onClick?: () => void;
}

function Cell({ node, isSelected, isUnhealthy, onClick }: CellProps) {
  const bg = loadColor(node.utilization);
  const isLight = node.utilization < 0.4;
  const textColor = isLight ? 'rgba(15,25,60,0.85)' : 'rgba(255,255,255,0.92)';
  const isClickable = !!onClick;

  const sharedStyle: React.CSSProperties = {
    background: bg,
    color: textColor,
  };

  const sharedClass = cn(
    'relative flex min-w-0 flex-1 flex-col items-center justify-center',
    'rounded-sm px-0.5 py-[3px] font-mono text-[10px] tabular-nums',
    'select-none transition-colors duration-150',
    isClickable &&
      'cursor-pointer hover:brightness-110 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
    isSelected && 'ring-2 ring-primary ring-inset',
    isUnhealthy && 'ring-2 ring-red-500 ring-inset',
  );

  const inner = (
    <>
      <span className="leading-none">{node.label}</span>
      {node.queueDepth > 0 && (
        <span
          role="img"
          aria-label="queued"
          className="queue-tick absolute bottom-[2px] right-[2px] h-1 w-1 rounded-full bg-amber-400"
        />
      )}
    </>
  );

  if (isClickable) {
    return (
      <button
        type="button"
        className={sharedClass}
        style={sharedStyle}
        onClick={onClick}
        data-selected={isSelected ? '' : undefined}
        data-unhealthy={isUnhealthy ? '' : undefined}
        title={`${node.label} · util ${(node.utilization * 100).toFixed(0)}%${node.queueDepth > 0 ? ` · queue ${node.queueDepth}` : ''}`}
      >
        {inner}
      </button>
    );
  }

  return (
    <div
      className={sharedClass}
      style={sharedStyle}
      data-unhealthy={isUnhealthy ? '' : undefined}
      title={`${node.label} · util ${(node.utilization * 100).toFixed(0)}%${node.queueDepth > 0 ? ` · queue ${node.queueDepth}` : ''}`}
    >
      {inner}
    </div>
  );
}

// ─── Tier row ─────────────────────────────────────────────────────────────────

interface TierRowProps {
  tier: 'clients' | 'envoys' | 'backends';
  nodes: TopologyNodeStatus[];
  selectedEnvoy?: number | null;
  onSelectEnvoy?: (index: number | null) => void;
}

const TIER_LABEL: Record<TierRowProps['tier'], string> = {
  clients: 'CLI',
  envoys: 'ENV',
  backends: 'BE',
};

function TierRow({ tier, nodes, selectedEnvoy, onSelectEnvoy }: TierRowProps) {
  return (
    <div data-tier={tier} className="flex items-stretch gap-[3px]">
      <span className="w-7 shrink-0 self-center font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
        {TIER_LABEL[tier]}
      </span>
      <div className="flex min-w-0 flex-1 gap-[3px]">
        {nodes.map((node) => {
          const isEnvoy = tier === 'envoys';
          const isSelected = isEnvoy && selectedEnvoy != null && node.index === selectedEnvoy;
          const isUnhealthy = tier === 'backends' && node.health >= 2;

          // Clicking the already-selected envoy toggles selection off (null);
          // clicking any other envoy selects it.
          const clickHandler =
            isEnvoy && onSelectEnvoy
              ? () => onSelectEnvoy(node.index === selectedEnvoy ? null : node.index)
              : undefined;

          return (
            <Cell
              key={node.index}
              node={node}
              isSelected={isSelected}
              isUnhealthy={isUnhealthy}
              {...(clickHandler ? { onClick: clickHandler } : {})}
            />
          );
        })}
      </div>
    </div>
  );
}

// ─── Legend ───────────────────────────────────────────────────────────────────

function Legend() {
  return (
    <div className="flex items-center gap-2 pt-1">
      <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
        load
      </span>
      <div className="flex items-center gap-1">
        <span className="font-mono text-[9px] text-muted-foreground">low</span>
        <div
          className="h-2 w-16 rounded-sm"
          style={{
            background:
              'linear-gradient(to right, hsl(210 60% 85%), hsl(210 90% 28%), hsl(38 95% 52%))',
          }}
          aria-hidden
        />
        <span className="font-mono text-[9px] text-muted-foreground">sat</span>
      </div>
    </div>
  );
}

// ─── FleetHeatmap ─────────────────────────────────────────────────────────────

interface FleetHeatmapProps {
  snapshot: TopologySnapshot;
  selectedEnvoy: number | null;
  onSelectEnvoy: (index: number | null) => void;
}

/**
 * Compact fleet-load heatmap: three tier rows (clients, envoys, backends),
 * one color-encoded cell per entity. Cell fill maps utilization onto a
 * sequential light-blue to navy ramp, clamped to amber at saturation.
 *
 * Envoy cells are interactive (buttons); client/backend cells are static.
 * A red inset ring marks unhealthy backends (health >= 2); a blue ring marks
 * the selected envoy. A small amber dot appears when a node has queue depth.
 */
export function FleetHeatmap({
  snapshot,
  selectedEnvoy,
  onSelectEnvoy,
}: FleetHeatmapProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-[5px] rounded-md border bg-card p-2 shadow-sm">
      <TierRow tier="clients" nodes={snapshot.clients} />
      <TierRow
        tier="envoys"
        nodes={snapshot.envoys}
        selectedEnvoy={selectedEnvoy}
        onSelectEnvoy={onSelectEnvoy}
      />
      <TierRow tier="backends" nodes={snapshot.backends} />
      <Legend />
    </div>
  );
}
