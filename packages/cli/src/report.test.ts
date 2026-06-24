import { describe, expect, it } from 'vitest';
import { formatRunReport, formatValidationReport, jsonReplacer } from './report';
import type { ValidationResult } from './validate';

const result: ValidationResult = {
  passed: 1,
  failed: 1,
  skipped: 1,
  policies: [
    {
      policy: 'maglev',
      lbLabel: 'real',
      cases: [
        {
          id: 'c1',
          title: 'Case one',
          checks: [
            { label: 'ok check', pass: true, detail: 'd1', requiresReal: false, status: 'pass' },
            { label: 'bad check', pass: false, detail: 'd2', requiresReal: false, status: 'fail' },
            { label: 'real check', pass: false, detail: 'd3', requiresReal: true, status: 'skip' },
          ],
        },
      ],
    },
  ],
};

describe('formatValidationReport', () => {
  it('renders policy header, badges, glyphs and a summary', () => {
    const text = formatValidationReport(result);
    expect(text).toMatch(/maglev/);
    expect(text).toMatch(/REAL/);
    expect(text).toContain('ok check');
    expect(text).toContain('bad check');
    expect(text).toContain('real check');
    expect(text).toMatch(/1 passed/);
    expect(text).toMatch(/1 failed/);
    expect(text).toMatch(/1 skipped/);
  });

  it('shows the fallback note when present', () => {
    const withNote: ValidationResult = {
      ...result,
      policies: [{ ...result.policies[0]!, lbLabel: 'mock', note: 'using mock LB' }],
    };
    expect(formatValidationReport(withNote)).toContain('using mock LB');
  });
});

describe('formatRunReport', () => {
  const stats = {
    perBackend: new Map([[0, { picks: 3, completed: 3 }]]),
    perEnvoy: new Map([[0, 3]]),
    outcomes: { completed: 3, timedOut: 0, rejected: 0, total: 3 },
    goodput: 1,
    latencyP50: 10,
    latencyP90: 12,
    latencyP99: 15,
    keyConsistency: new Map(),
  };

  it('renders a distribution table and aggregates', () => {
    const text = formatRunReport(stats, { policy: 'maglev', lbLabel: 'real' });
    expect(text).toMatch(/goodput/i);
    expect(text).toContain('100.00%');
  });

  it('shows note when provided', () => {
    const text = formatRunReport(stats, { policy: 'maglev', lbLabel: 'mock', note: 'fallback' });
    expect(text).toContain('fallback');
    expect(text).toContain('[MOCK]');
  });
});

describe('jsonReplacer', () => {
  it('serializes Map and Set', () => {
    const json = JSON.stringify({ m: new Map([[1, 2]]), s: new Set([3]) }, jsonReplacer);
    expect(JSON.parse(json)).toEqual({ m: { '1': 2 }, s: [3] });
  });
});
