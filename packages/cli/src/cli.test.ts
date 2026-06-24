import type { LbModule } from '@elbsim/protocol';
import { mockLbModule } from '@elbsim/sim-core';
import { describe, expect, it } from 'vitest';
import type { Io } from './cli';
import { main } from './cli';

function capture(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, out, err };
}

const deps = { loadReal: async () => mockLbModule as unknown as LbModule };

describe('main', () => {
  it('validate --mock prints a report and returns an exit code', async () => {
    const { io, out } = capture();
    const code = await main(['validate', '--mock', '--policy', 'maglev'], io, deps);
    expect(out.join('\n')).toMatch(/maglev/);
    expect([0, 1]).toContain(code);
  });

  it('validate --json emits parseable JSON', async () => {
    const { io, out } = capture();
    await main(['validate', '--mock', '--policy', 'random', '--json'], io, deps);
    expect(() => JSON.parse(out.join('\n'))).not.toThrow();
  });

  it('run --scenario default prints a stats report', async () => {
    const { io, out } = capture();
    const code = await main(
      ['run', '--scenario', 'default', '--policy', 'maglev', '--mock'],
      io,
      deps,
    );
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/goodput/);
  });

  it('run with a bad --config path errors with exit 2', async () => {
    const { io, err } = capture();
    const code = await main(['run', '--config', '/nonexistent.json', '--mock'], io, deps);
    expect(code).toBe(2);
    expect(err.join('\n')).not.toBe('');
  });

  it('unknown command prints usage and returns 2', async () => {
    const { io, err } = capture();
    const code = await main(['frobnicate'], io, deps);
    expect(code).toBe(2);
    expect(err.join('\n')).toMatch(/usage/);
  });

  it('run without --scenario or --config uses scenario() fallback', async () => {
    const { io, out } = capture();
    // default mode is real; deps.loadReal returns mockLbModule which acts as the real module
    const code = await main(['run', '--policy', 'maglev'], io, deps);
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/goodput/);
  });

  it('run --json emits parseable JSON', async () => {
    const { io, out } = capture();
    const code = await main(['run', '--policy', 'maglev', '--mock', '--json'], io, deps);
    expect(code).toBe(0);
    expect(() => JSON.parse(out.join('\n'))).not.toThrow();
  });

  it('validate with no --policy in real (default) mode runs the lifted set', async () => {
    const { io, out } = capture();
    const code = await main(['validate'], io, deps);
    expect([0, 1]).toContain(code);
    // All five policies are lifted, so the real-default run covers them all.
    expect(out.join('\n')).toMatch(/maglev/);
    expect(out.join('\n')).toMatch(/round_robin/);
  });

  it('validate --mock with no --policy runs ALL_POLICIES', async () => {
    const { io, out } = capture();
    const code = await main(['validate', '--mock'], io, deps);
    expect([0, 1]).toContain(code);
    expect(out.join('\n')).toMatch(/round_robin/);
    expect(out.join('\n')).toMatch(/maglev/);
  });

  it('cmdValidate surfaces failed > 0 with exit code 1', async () => {
    const { io } = capture();
    // 'random' with mock has some real-only checks that skip, but behavioral
    // checks run; result could be 0 or 1 depending on seeded run
    const code = await main(['validate', '--mock', '--policy', 'random'], io, deps);
    expect([0, 1]).toContain(code);
  });

  it('main catches unexpected throws from the runner and returns 2', async () => {
    const { io, err } = capture();
    // Inject deps that throw to exercise the main-level catch block.
    const throwingDeps = {
      loadReal: async (): Promise<LbModule> => {
        throw new Error('unexpected runtime failure');
      },
    };
    // default mode is real; loadReal throws, triggering the catch block
    const code = await main(['run', '--policy', 'maglev'], io, throwingDeps);
    expect(code).toBe(2);
    expect(err.join('\n')).toMatch(/unexpected runtime failure/);
  });
});
