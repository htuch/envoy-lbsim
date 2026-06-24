import { readFileSync } from 'node:fs';
import {
  defaultSimConfig,
  type EnvoyLbPolicyKind,
  type SimConfig,
  SimConfig as SimConfigSchema,
} from '@elbsim/config';
import { scenario } from './cases/scenario';
import { ALL_POLICIES } from './cases/types';
import { runScenario } from './driver';
import { type LbMode, LIFTED_POLICIES, type SelectDeps, selectLb } from './lb-select';
import { formatRunReport, formatValidationReport, jsonReplacer } from './report';
import { computeStats } from './stats';
import { runValidation } from './validate';

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

/* c8 ignore next 4 -- only used when no custom Io is passed (i.e. the real bin) */
export const defaultIo: Io = {
  out: (s) => console.log(s),
  err: (s) => console.error(s),
};

interface Flags {
  policies: EnvoyLbPolicyKind[];
  json: boolean;
  mode: LbMode;
  config?: string;
  scenario?: string;
}

const USAGE =
  'usage: elbsim <run|validate> [--policy p]... [--mock] [--json] [--config file|--scenario name]';

function isPolicy(s: string): s is EnvoyLbPolicyKind {
  return (ALL_POLICIES as readonly string[]).includes(s);
}

function parseFlags(args: readonly string[]): Flags {
  const policies: EnvoyLbPolicyKind[] = [];
  let json = false;
  let mock = false;
  let config: string | undefined;
  let scenarioName: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--json':
        json = true;
        break;
      case '--mock':
        mock = true;
        break;
      case '--policy': {
        const v = args[++i];
        if (v && isPolicy(v)) policies.push(v);
        break;
      }
      case '--config':
        config = args[++i];
        break;
      case '--scenario':
        scenarioName = args[++i];
        break;
    }
  }
  const mode: LbMode = mock ? 'mock' : 'real';
  return {
    policies,
    json,
    mode,
    ...(config ? { config } : {}),
    ...(scenarioName ? { scenario: scenarioName } : {}),
  };
}

function loadScenario(flags: Flags, policy: EnvoyLbPolicyKind): SimConfig {
  if (flags.config) {
    const raw = readFileSync(flags.config, 'utf8');
    return SimConfigSchema.parse(JSON.parse(raw));
  }
  if (flags.scenario === 'default') return defaultSimConfig();
  return scenario(policy);
}

async function cmdValidate(flags: Flags, io: Io, deps?: SelectDeps): Promise<number> {
  const policies = flags.policies.length
    ? flags.policies
    : flags.mode === 'mock'
      ? ALL_POLICIES
      : ALL_POLICIES.filter((p) => LIFTED_POLICIES.has(p));
  const result = await runValidation(policies, flags.mode, deps);
  io.out(flags.json ? JSON.stringify(result, jsonReplacer, 2) : formatValidationReport(result));
  return result.failed > 0 ? 1 : 0;
}

async function cmdRun(flags: Flags, io: Io, deps?: SelectDeps): Promise<number> {
  const policy = flags.policies[0] ?? 'maglev';
  let config: SimConfig;
  try {
    config = loadScenario(flags, policy);
  } catch (e) {
    io.err(`failed to load scenario: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const sel = await selectLb(policy, flags.mode, deps);
  const { events } = runScenario(config, { module: sel.module, label: sel.label });
  const stats = computeStats(events);
  const meta = { policy, lbLabel: sel.label };
  io.out(
    flags.json ? JSON.stringify({ meta, stats }, jsonReplacer, 2) : formatRunReport(stats, meta),
  );
  return 0;
}

/** CLI entry. Returns the process exit code; never throws for normal usage. */
export async function main(
  argv: readonly string[],
  io: Io = defaultIo,
  deps?: SelectDeps,
): Promise<number> {
  const [cmd, ...rest] = argv;
  const flags = parseFlags(rest);
  try {
    if (cmd === 'validate') return await cmdValidate(flags, io, deps);
    if (cmd === 'run') return await cmdRun(flags, io, deps);
  } catch (e) {
    io.err(e instanceof Error ? e.message : String(e));
    return 2;
  }
  io.err(USAGE);
  return 2;
}
