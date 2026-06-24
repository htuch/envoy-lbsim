import {
  ArrivalProcess,
  type EnvoyLbPolicy,
  EnvoyLbPolicy as EnvoyLbPolicySchema,
  type SimConfig,
  safeParseSimConfig,
} from '@elbsim/config';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { NumberInput } from '@/components/ui/number-input';
import { Select } from '@/components/ui/select';
import { useSimStore } from '@/store/sim-store';

/**
 * The scenario editor: typed controls over the `@elbsim/config` schema. Edits
 * mutate the in-store draft; "Apply" validates the whole config through the Zod
 * schema (the single source of truth) before handing it to the worker for a
 * fresh deterministic run. Grouped, dense, and aligned to the instrument-panel
 * aesthetic rather than a sprawling form.
 */
const ARRIVAL_KINDS = [
  { value: 'poisson', label: 'Poisson' },
  { value: 'periodic', label: 'Periodic' },
  { value: 'uniform', label: 'Uniform' },
] as const;

const POLICY_KINDS = [
  { value: 'round_robin', label: 'Round robin' },
  { value: 'least_request', label: 'Least request' },
  { value: 'random', label: 'Random' },
  { value: 'ring_hash', label: 'Ring hash' },
  { value: 'maglev', label: 'Maglev' },
] as const;

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="border-b py-2 last:border-b-0">
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  );
}

export function ConfigEditor(): React.JSX.Element {
  const config = useSimStore((s) => s.config);
  const setConfig = useSimStore((s) => s.setConfig);
  const load = useSimStore((s) => s.load);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const update = (next: SimConfig): void => setConfig(next);
  const setPolicy = (policy: EnvoyLbPolicy): void =>
    update({ ...config, envoys: { ...config.envoys, policy } });

  const apply = async (): Promise<void> => {
    const parsed = safeParseSimConfig(config);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'invalid configuration');
      return;
    }
    setError(null);
    setApplying(true);
    try {
      await load(parsed.data);
    } finally {
      setApplying(false);
    }
  };

  const policy = config.envoys.policy;

  return (
    <div className="flex flex-col">
      <Section title="Run">
        <Field label="Seed" htmlFor="cfg-seed">
          <NumberInput
            id="cfg-seed"
            value={config.seed}
            min={0}
            step={1}
            onValueChange={(seed) => update({ ...config, seed: Math.floor(seed) })}
          />
        </Field>
        <Field label="Duration (ms)" htmlFor="cfg-duration">
          <NumberInput
            id="cfg-duration"
            value={config.time.durationMs}
            min={1}
            step={1000}
            onValueChange={(durationMs) =>
              update({ ...config, time: { ...config.time, durationMs } })
            }
          />
        </Field>
        <Field label="Sample (ms)" htmlFor="cfg-sample">
          <NumberInput
            id="cfg-sample"
            value={config.time.sampleIntervalMs}
            min={1}
            step={1}
            onValueChange={(sampleIntervalMs) =>
              update({ ...config, time: { ...config.time, sampleIntervalMs } })
            }
          />
        </Field>
      </Section>

      <Section title="Clients">
        <Field label="Count" htmlFor="cfg-clients">
          <NumberInput
            id="cfg-clients"
            value={config.clients.count}
            min={1}
            step={1}
            onValueChange={(count) =>
              update({ ...config, clients: { ...config.clients, count: Math.floor(count) } })
            }
          />
        </Field>
        <Field label="Arrival">
          <Select
            aria-label="Arrival process"
            value={config.clients.arrival.kind}
            options={[...ARRIVAL_KINDS]}
            onChange={(e) =>
              update({
                ...config,
                clients: {
                  ...config.clients,
                  arrival: ArrivalProcess.parse({
                    kind: e.target.value,
                    ratePerSec: config.clients.arrival.ratePerSec,
                  }),
                },
              })
            }
          />
        </Field>
        <Field label="Rate (/s)" htmlFor="cfg-rate">
          <NumberInput
            id="cfg-rate"
            value={config.clients.arrival.ratePerSec}
            min={0.1}
            step={1}
            onValueChange={(ratePerSec) =>
              update({
                ...config,
                clients: {
                  ...config.clients,
                  arrival: { ...config.clients.arrival, ratePerSec },
                },
              })
            }
          />
        </Field>
      </Section>

      <Section title="Envoys">
        <Field label="Count" htmlFor="cfg-envoys">
          <NumberInput
            id="cfg-envoys"
            value={config.envoys.count}
            min={1}
            step={1}
            onValueChange={(count) =>
              update({ ...config, envoys: { ...config.envoys, count: Math.floor(count) } })
            }
          />
        </Field>
        <Field label="Policy">
          <Select
            aria-label="LB policy"
            value={policy.kind}
            options={[...POLICY_KINDS]}
            onChange={(e) => setPolicy(EnvoyLbPolicySchema.parse({ kind: e.target.value }))}
          />
        </Field>
        {policy.kind === 'maglev' && (
          <Field label="Table size" htmlFor="cfg-maglev">
            <NumberInput
              id="cfg-maglev"
              value={policy.tableSize}
              min={2}
              step={2}
              onValueChange={(tableSize) =>
                setPolicy({ ...policy, tableSize: Math.floor(tableSize) })
              }
            />
          </Field>
        )}
        {policy.kind === 'ring_hash' && (
          <Field label="Min ring" htmlFor="cfg-ring">
            <NumberInput
              id="cfg-ring"
              value={policy.minimumRingSize}
              min={1}
              step={64}
              onValueChange={(minimumRingSize) =>
                setPolicy({ ...policy, minimumRingSize: Math.floor(minimumRingSize) })
              }
            />
          </Field>
        )}
        {policy.kind === 'least_request' && (
          <Field label="Choices" htmlFor="cfg-choices">
            <NumberInput
              id="cfg-choices"
              value={policy.choiceCount}
              min={2}
              step={1}
              onValueChange={(choiceCount) =>
                setPolicy({ ...policy, choiceCount: Math.floor(choiceCount) })
              }
            />
          </Field>
        )}
      </Section>

      <Section title="Backends">
        <Field label="Count" htmlFor="cfg-backends">
          <NumberInput
            id="cfg-backends"
            value={config.backends.count}
            min={1}
            step={1}
            onValueChange={(count) =>
              update({ ...config, backends: { ...config.backends, count: Math.floor(count) } })
            }
          />
        </Field>
        <Field label="Capacity" htmlFor="cfg-capacity">
          <NumberInput
            id="cfg-capacity"
            value={config.backends.defaults.capacity}
            min={1}
            step={1}
            onValueChange={(capacity) =>
              update({
                ...config,
                backends: {
                  ...config.backends,
                  defaults: { ...config.backends.defaults, capacity: Math.floor(capacity) },
                },
              })
            }
          />
        </Field>
      </Section>

      <Section title="Timeouts">
        <Field label="Request (ms)" htmlFor="cfg-timeout">
          <NumberInput
            id="cfg-timeout"
            value={config.timeouts.requestTimeoutMs}
            min={1}
            step={10}
            onValueChange={(requestTimeoutMs) =>
              update({ ...config, timeouts: { ...config.timeouts, requestTimeoutMs } })
            }
          />
        </Field>
      </Section>

      <div className="pt-3">
        {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
        <Button className="w-full" disabled={applying} onClick={() => void apply()}>
          {applying ? 'Applying…' : 'Apply & reload'}
        </Button>
      </div>
    </div>
  );
}
