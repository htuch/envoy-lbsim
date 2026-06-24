import type { InspectedHost } from '@elbsim/protocol';
import { backendColor } from './colors';

/** InspectedHost health (0 unhealthy, 1 degraded, 2 healthy) -> label + color. */
const HOST_HEALTH = [
  { label: 'unhealthy', color: 'hsl(0 72% 52%)' },
  { label: 'degraded', color: 'hsl(40 90% 50%)' },
  { label: 'healthy', color: 'hsl(150 60% 42%)' },
] as const;

/**
 * The resolved host set the LB currently sees, post health/weight resolution.
 * Shared across every structure view so an Envoy's membership is always visible.
 */
export function HostsTable({ hosts }: { hosts: InspectedHost[] }): React.JSX.Element {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b text-left text-[10px] uppercase tracking-wider text-muted-foreground">
          <th className="py-1 pr-2 font-medium">host</th>
          <th className="py-1 pr-2 text-right font-medium">weight</th>
          <th className="py-1 pr-2 font-medium">health</th>
          <th className="py-1 pr-2 text-right font-medium">pri</th>
          <th className="py-1 pr-2 font-medium">zone</th>
          <th className="py-1 text-right font-medium">active</th>
        </tr>
      </thead>
      <tbody>
        {hosts.map((h) => {
          // health is the 0|1|2 ordinal, always a valid index into HOST_HEALTH.
          const health = HOST_HEALTH[h.health]!;
          return (
            <tr key={h.backend} className="border-b border-border/50 last:border-0">
              <td className="py-1 pr-2">
                <span className="flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="inline-block h-2 w-2 rounded-[2px]"
                    style={{ background: backendColor(h.backend) }}
                  />
                  <span className="font-mono tabular-nums">b{h.backend}</span>
                </span>
              </td>
              <td className="py-1 pr-2 text-right font-mono tabular-nums">{h.weight}</td>
              <td className="py-1 pr-2">
                <span className="flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="inline-block h-1.5 w-1.5 rounded-full"
                    style={{ background: health.color }}
                  />
                  {health.label}
                </span>
              </td>
              <td className="py-1 pr-2 text-right font-mono tabular-nums">{h.priority}</td>
              <td className="py-1 pr-2 font-mono">
                {h.region}/{h.zone}
              </td>
              <td className="py-1 text-right font-mono tabular-nums">{h.activeRequests}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
