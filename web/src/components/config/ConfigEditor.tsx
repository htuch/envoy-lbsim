import {
  ArrivalProcess,
  type Distribution,
  Distribution as DistributionSchema,
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

const LATENCY_DIST_KINDS = [
  { value: 'constant', label: 'Constant' },
  { value: 'uniform', label: 'Uniform' },
  { value: 'normal', label: 'Normal' },
  { value: 'exponential', label: 'Exponential' },
  { value: 'lognormal', label: 'Log-normal' },
  { value: 'pareto', label: 'Pareto' },
] as const;

type LatencyKind = (typeof LATENCY_DIST_KINDS)[number]['value'];

/** Schema-valid default object for each distribution kind. */
const LATENCY_KIND_DEFAULTS: Record<LatencyKind, Distribution> = {
  constant: { kind: 'constant', value: 10 },
  uniform: { kind: 'uniform', min: 5, max: 20 },
  normal: { kind: 'normal', mean: 10, stddev: 3 },
  exponential: { kind: 'exponential', ratePerMs: 0.1 },
  lognormal: { kind: 'lognormal', mu: 2.3, sigma: 0.4 },
  pareto: { kind: 'pareto', scale: 5, shape: 2 },
};

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
  const raiseError = useSimStore((s) => s.raiseError);
  const [applying, setApplying] = useState(false);

  const update = (next: SimConfig): void => setConfig(next);
  const setPolicy = (policy: EnvoyLbPolicy): void =>
    update({ ...config, envoys: { ...config.envoys, policy } });

  const setLatency = (latency: Distribution): void =>
    update({
      ...config,
      backends: {
        ...config.backends,
        defaults: { ...config.backends.defaults, latency },
      },
    });

  const apply = async (): Promise<void> => {
    const parsed = safeParseSimConfig(config);
    if (!parsed.success) {
      raiseError(parsed.error.issues[0]?.message ?? 'Invalid configuration');
      return;
    }
    setApplying(true);
    try {
      await load(parsed.data);
    } catch (err) {
      // A reload can reject deep in the worker (e.g. Envoy aborts on a Maglev
      // table size the schema somehow let through). Surface it instead of
      // letting the old run keep playing silently.
      raiseError(`Reload failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setApplying(false);
    }
  };

  const policy = config.envoys.policy;
  const latency = config.backends.defaults.latency;

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
          <>
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
            <Field label="Max ring" htmlFor="cfg-ring-max">
              <NumberInput
                id="cfg-ring-max"
                value={policy.maximumRingSize}
                min={1}
                step={64}
                onValueChange={(maximumRingSize) =>
                  setPolicy({ ...policy, maximumRingSize: Math.floor(maximumRingSize) })
                }
              />
            </Field>
          </>
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
        <Field label="Processing time (ms)">
          <Select
            aria-label="Backend processing time distribution kind"
            value={latency.kind}
            options={[...LATENCY_DIST_KINDS]}
            onChange={(e) => {
              const kind = e.target.value as LatencyKind;
              setLatency(DistributionSchema.parse(LATENCY_KIND_DEFAULTS[kind]));
            }}
          />
        </Field>
        {latency.kind === 'constant' && (
          <Field label="Value (ms)" htmlFor="cfg-latency-value">
            <NumberInput
              id="cfg-latency-value"
              value={latency.value}
              min={0}
              step={1}
              onValueChange={(value) => setLatency({ kind: 'constant', value })}
            />
          </Field>
        )}
        {latency.kind === 'uniform' && (
          <>
            <Field label="Min (ms)" htmlFor="cfg-latency-min">
              <NumberInput
                id="cfg-latency-min"
                value={latency.min}
                min={0}
                step={1}
                onValueChange={(min) => setLatency({ kind: 'uniform', min, max: latency.max })}
              />
            </Field>
            <Field label="Max (ms)" htmlFor="cfg-latency-max">
              <NumberInput
                id="cfg-latency-max"
                value={latency.max}
                min={0}
                step={1}
                onValueChange={(max) => setLatency({ kind: 'uniform', min: latency.min, max })}
              />
            </Field>
          </>
        )}
        {latency.kind === 'normal' && (
          <>
            <Field label="Mean (ms)" htmlFor="cfg-latency-mean">
              <NumberInput
                id="cfg-latency-mean"
                value={latency.mean}
                min={0}
                step={1}
                onValueChange={(mean) =>
                  setLatency({ kind: 'normal', mean, stddev: latency.stddev })
                }
              />
            </Field>
            <Field label="Std dev (ms)" htmlFor="cfg-latency-stddev">
              <NumberInput
                id="cfg-latency-stddev"
                value={latency.stddev}
                min={0}
                step={0.1}
                onValueChange={(stddev) =>
                  setLatency({ kind: 'normal', mean: latency.mean, stddev })
                }
              />
            </Field>
          </>
        )}
        {latency.kind === 'exponential' && (
          <Field label="Rate (events/ms)" htmlFor="cfg-latency-rate">
            <NumberInput
              id="cfg-latency-rate"
              value={latency.ratePerMs}
              min={0.0001}
              step={0.01}
              onValueChange={(ratePerMs) => setLatency({ kind: 'exponential', ratePerMs })}
            />
          </Field>
        )}
        {latency.kind === 'lognormal' && (
          <>
            <Field label="Mu" htmlFor="cfg-latency-mu">
              <NumberInput
                id="cfg-latency-mu"
                value={latency.mu}
                step={0.1}
                onValueChange={(mu) => setLatency({ kind: 'lognormal', mu, sigma: latency.sigma })}
              />
            </Field>
            <Field label="Sigma" htmlFor="cfg-latency-sigma">
              <NumberInput
                id="cfg-latency-sigma"
                value={latency.sigma}
                min={0.0001}
                step={0.1}
                onValueChange={(sigma) => setLatency({ kind: 'lognormal', mu: latency.mu, sigma })}
              />
            </Field>
          </>
        )}
        {latency.kind === 'pareto' && (
          <>
            <Field label="Scale (ms)" htmlFor="cfg-latency-scale">
              <NumberInput
                id="cfg-latency-scale"
                value={latency.scale}
                min={0.0001}
                step={1}
                onValueChange={(scale) =>
                  setLatency({ kind: 'pareto', scale, shape: latency.shape })
                }
              />
            </Field>
            <Field label="Shape" htmlFor="cfg-latency-shape">
              <NumberInput
                id="cfg-latency-shape"
                value={latency.shape}
                min={0.0001}
                step={0.1}
                onValueChange={(shape) =>
                  setLatency({ kind: 'pareto', scale: latency.scale, shape })
                }
              />
            </Field>
          </>
        )}
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
        <Button className="w-full" disabled={applying} onClick={() => void apply()}>
          {applying ? 'Applying…' : 'Apply & reload'}
        </Button>
      </div>
    </div>
  );
}
