import type { LbInspection, LbStructure } from '@elbsim/protocol';
import { EdfHeapView } from './EdfHeapView';
import { HostsTable } from './HostsTable';
import { MaglevTableView } from './MaglevTableView';
import { RingHashView } from './RingHashView';

/** Human label for each structure kind, shown as the structure panel title. */
const STRUCTURE_TITLE: Record<LbStructure['kind'], string> = {
  edf: 'EDF scheduler',
  maglev: 'Maglev table',
  ring: 'Hash ring',
  none: 'No structure',
};

/**
 * The LB data-structure inspector: the signature view. Renders one
 * `LbInspection` (the real LB structures serialized from Wasm memory at a
 * virtual instant) as the resolved host set plus the policy-specific structure.
 * Production-faithful and prop-driven; the harness supplies synthetic payloads
 * and the worker supplies real ones via deterministic replay.
 */
export function LbInspector({ inspection }: { inspection: LbInspection }): React.JSX.Element {
  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto max-w-3xl space-y-4">
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold tracking-tight">
            LB inspector{' '}
            <span className="font-mono tabular-nums text-muted-foreground">
              e{inspection.envoy}
            </span>
          </h2>
          <span className="flex items-center gap-3 font-mono text-xs tabular-nums text-muted-foreground">
            <span>{inspection.policy}</span>
            <span>t = {inspection.t} ms</span>
            {inspection.panic && (
              <span className="rounded bg-red-500/15 px-1.5 py-0.5 font-sans text-red-600 dark:text-red-400">
                PANIC
              </span>
            )}
          </span>
        </header>

        {/* Vertical column: the LB structure on top, the resolved host set
            below it, so the dock scrolls structure-then-hosts in one column. */}
        <div className="flex flex-col gap-4">
          <section className="space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {STRUCTURE_TITLE[inspection.structure.kind]}
            </p>
            <div className="rounded-md border bg-card p-2.5">
              <StructureView structure={inspection.structure} />
            </div>
          </section>

          <section className="space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Resolved hosts
            </p>
            <div className="rounded-md border bg-card p-2.5">
              <HostsTable hosts={inspection.hosts} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function StructureView({ structure }: { structure: LbStructure }): React.JSX.Element {
  switch (structure.kind) {
    case 'edf':
      return <EdfHeapView edf={structure} />;
    case 'maglev':
      return <MaglevTableView maglev={structure} />;
    case 'ring':
      return <RingHashView ring={structure} />;
    case 'none':
      return (
        <p className="text-xs text-muted-foreground">
          Random selection holds no persistent structure; each pick is an independent draw over the
          healthy host set.
        </p>
      );
  }
}
