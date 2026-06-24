import { describe, expect, it } from 'vitest';
import { harnessScenario } from '@/components/harness/scenario';
import { makeTopologySnapshot } from '@/synthetic';
import { layoutTopology, nodeId } from './layout';

const snapshot = makeTopologySnapshot(harnessScenario(), 1200);

describe('layoutTopology', () => {
  it('emits one node per entity with stable ids', () => {
    const { nodes } = layoutTopology(snapshot);
    expect(nodes).toHaveLength(
      snapshot.clients.length + snapshot.envoys.length + snapshot.backends.length,
    );
    expect(nodes.map((n) => n.id)).toContain(nodeId('envoy', 0));
    expect(nodes.map((n) => n.id)).toContain(nodeId('backend', 5));
  });

  it('lays clients, Envoys, then backends out left to right', () => {
    const { nodes } = layoutTopology(snapshot);
    const xOf = (kind: 'client' | 'envoy' | 'backend', index: number) =>
      nodes.find((n) => n.id === nodeId(kind, index))!.position.x;
    expect(xOf('client', 0)).toBeLessThan(xOf('envoy', 0));
    expect(xOf('envoy', 0)).toBeLessThan(xOf('backend', 0));
  });

  it('marks only Envoy nodes selectable and carries node status', () => {
    const { nodes } = layoutTopology(snapshot);
    const envoy = nodes.find((n) => n.id === nodeId('envoy', 1))!;
    const backend = nodes.find((n) => n.id === nodeId('backend', 0))!;
    expect(envoy.selectable).toBe(true);
    expect(backend.selectable).toBe(false);
    expect(envoy.data.status.kind).toBe('envoy');
  });

  it('emits one edge per snapshot edge, weighted by share', () => {
    const { edges } = layoutTopology(snapshot);
    expect(edges).toHaveLength(snapshot.edges.length);
    // A heavier-share edge draws a thicker stroke.
    const widths = edges.map((e) => Number((e.style as { strokeWidth: number }).strokeWidth));
    expect(Math.max(...widths)).toBeGreaterThan(Math.min(...widths));
  });
});
