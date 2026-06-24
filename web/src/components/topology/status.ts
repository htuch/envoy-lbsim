import type { TopologyNodeStatus } from '@/synthetic';

/**
 * Visual encodings for topology node status. Kept pure and separate from the
 * React node so the color/label logic is unit-testable without a DOM.
 */

/** Continuous load heat (green -> amber -> red) for a value in [0,1]. */
export function utilizationColor(u: number): string {
  const clamped = Math.max(0, Math.min(1, u));
  // Hue sweeps 140deg (green) down to 0deg (red) as load rises.
  const hue = Math.round(140 - 140 * clamped);
  return `hsl(${hue} 72% 45%)`;
}

/** Backend health ordinal (0 healthy .. 3 draining) -> label and dot color. */
const BACKEND_HEALTH = [
  { label: 'healthy', color: 'hsl(150 65% 42%)' },
  { label: 'degraded', color: 'hsl(40 90% 50%)' },
  { label: 'unhealthy', color: 'hsl(0 75% 52%)' },
  { label: 'draining', color: 'hsl(220 10% 55%)' },
] as const;

export interface StatusBadge {
  label: string;
  color: string;
}

/**
 * The headline status badge for a node: backend health, Envoy panic, or a
 * neutral "active" for clients and calm Envoys.
 */
export function statusBadge(status: TopologyNodeStatus): StatusBadge {
  if (status.kind === 'backend') {
    return BACKEND_HEALTH[status.health] ?? BACKEND_HEALTH[0];
  }
  if (status.kind === 'envoy' && status.panic) {
    return { label: 'panic', color: 'hsl(0 75% 52%)' };
  }
  return { label: 'active', color: 'hsl(220 10% 60%)' };
}
