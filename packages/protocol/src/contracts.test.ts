import { describe, expect, it } from 'vitest';
import { TERMINAL_PHASES } from './events';
import { ENTITY_KINDS } from './ids';

describe('protocol constants', () => {
  it('enumerates the entity kinds', () => {
    expect(ENTITY_KINDS).toEqual(['client', 'envoy', 'backend']);
  });

  it('marks the lifecycle-closing phases as terminal', () => {
    expect(TERMINAL_PHASES.has('completed')).toBe(true);
    expect(TERMINAL_PHASES.has('timed_out')).toBe(true);
    expect(TERMINAL_PHASES.has('rejected')).toBe(true);
    expect(TERMINAL_PHASES.has('emitted')).toBe(false);
  });
});
