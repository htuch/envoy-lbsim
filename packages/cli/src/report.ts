import type { EnvoyLbPolicyKind } from '@elbsim/config';
import type { LbLabel } from './driver';
import type { Stats } from './stats';
import type { ValidationResult } from './validate';

export interface RunMeta {
  policy: EnvoyLbPolicyKind;
  lbLabel: LbLabel;
  note?: string;
}

const GLYPH: Record<'pass' | 'fail' | 'skip', string> = {
  pass: 'PASS',
  fail: 'FAIL',
  skip: 'SKIP',
};

function badge(label: LbLabel): string {
  return label === 'real' ? '[REAL]' : '[MOCK]';
}

/** Human-readable per-policy validation report. */
export function formatValidationReport(result: ValidationResult): string {
  const lines: string[] = [];
  for (const p of result.policies) {
    lines.push('');
    lines.push(`${p.policy} ${badge(p.lbLabel)}${p.note ? `  (${p.note})` : ''}`);
    for (const c of p.cases) {
      lines.push(`  ${c.title}`);
      for (const chk of c.checks) {
        lines.push(`    ${GLYPH[chk.status]}  ${chk.label}  ${chk.detail}`);
      }
    }
  }
  lines.push('');
  lines.push(`${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped`);
  return lines.join('\n');
}

/** Human-readable single-run stats report (the `run` subcommand). */
export function formatRunReport(stats: Stats, meta: RunMeta): string {
  const lines: string[] = [];
  lines.push(
    `scenario: ${meta.policy} ${badge(meta.lbLabel)}${meta.note ? `  (${meta.note})` : ''}`,
  );
  lines.push('');
  lines.push('backend  picks  completed');
  const rows = [...stats.perBackend.entries()].sort(([a], [b]) => a - b);
  for (const [b, c] of rows) {
    lines.push(
      `${String(b).padStart(7)}  ${String(c.picks).padStart(5)}  ${String(c.completed).padStart(9)}`,
    );
  }
  lines.push('');
  lines.push(
    `requests: ${stats.outcomes.total}  completed: ${stats.outcomes.completed}  timed_out: ${stats.outcomes.timedOut}  rejected: ${stats.outcomes.rejected}`,
  );
  lines.push(`goodput: ${(stats.goodput * 100).toFixed(2)}%`);
  lines.push(
    `latency p50/p90/p99 (ms): ${stats.latencyP50.toFixed(2)} / ${stats.latencyP90.toFixed(2)} / ${stats.latencyP99.toFixed(2)}`,
  );
  return lines.join('\n');
}

/** JSON.stringify replacer that serializes Map -> object and Set -> array. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  return value;
}
