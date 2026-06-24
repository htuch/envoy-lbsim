import { Handle, type NodeProps, Position } from '@xyflow/react';
import { cn } from '@/lib/utils';
import type { EntityNode as EntityNodeType } from './layout';
import { statusBadge, utilizationColor } from './status';

/**
 * Compact live-status node for the topology graph. Renders a status dot, the
 * entity label, in-flight load with a utilization heat bar, and an admission
 * queue bar when the entity queues. Envoy nodes show panic and a selection ring.
 */
export function EntityNode({ data, selected }: NodeProps<EntityNodeType>): React.JSX.Element {
  const { status } = data;
  const badge = statusBadge(status);
  const isEnvoy = status.kind === 'envoy';
  const showLoad = status.kind !== 'client';
  const showQueue = status.queueCapacity > 0;

  return (
    <div
      title={`${status.label} · ${status.region}/${status.zone}`}
      className={cn(
        'rounded-md border bg-card px-2 py-1.5 text-card-foreground shadow-sm transition-shadow',
        status.kind === 'client' ? 'w-[92px]' : 'w-[120px]',
        isEnvoy && 'w-[132px]',
        isEnvoy && status.panic && 'border-red-500/70',
        selected && 'ring-2 ring-primary',
      )}
    >
      {status.kind !== 'client' && (
        <Handle
          type="target"
          position={Position.Left}
          className="!h-1.5 !w-1.5 !border-0 !bg-muted-foreground/50"
        />
      )}
      <div className="flex items-center justify-between gap-1">
        <span className="font-mono text-xs font-medium tabular-nums">{status.label}</span>
        <span className="flex items-center gap-1">
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: badge.color }}
          />
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {badge.label}
          </span>
        </span>
      </div>

      {showLoad && (
        <div className="mt-1">
          <div className="flex items-baseline justify-between">
            <span className="text-[10px] text-muted-foreground">in-flight</span>
            <span className="font-mono text-[11px] tabular-nums">{status.inFlight}</span>
          </div>
          <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full"
              style={{
                width: `${status.utilization * 100}%`,
                background: utilizationColor(status.utilization),
              }}
            />
          </div>
        </div>
      )}

      {showQueue && (
        <div className="mt-1">
          <div className="flex items-baseline justify-between">
            <span className="text-[10px] text-muted-foreground">queue</span>
            <span className="font-mono text-[11px] tabular-nums">
              {status.queueDepth}/{status.queueCapacity}
            </span>
          </div>
          <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-amber-500"
              style={{ width: `${(status.queueDepth / status.queueCapacity) * 100}%` }}
            />
          </div>
        </div>
      )}

      {status.kind === 'backend' && (
        <Handle
          type="source"
          position={Position.Right}
          className="!h-1.5 !w-1.5 !border-0 !bg-muted-foreground/50"
        />
      )}
      {isEnvoy && (
        <Handle
          type="source"
          position={Position.Right}
          className="!h-1.5 !w-1.5 !border-0 !bg-muted-foreground/50"
        />
      )}
    </div>
  );
}
