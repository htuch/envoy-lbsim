import { defaultSimConfig } from '@elbsim/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockSimRunner } from '@/worker/runner';
import { useSimStore } from './sim-store';

function reset(): void {
  useSimStore.setState(useSimStore.getInitialState(), true);
}

describe('useSimStore', () => {
  beforeEach(reset);
  afterEach(() => {
    const { api } = useSimStore.getState();
    if (api && 'dispose' in api) (api as MockSimRunner).dispose();
    reset();
  });

  it('starts idle and unattached', () => {
    const s = useSimStore.getState();
    expect(s.api).toBeNull();
    expect(s.ready).toBe(false);
    expect(s.status.state).toBe('idle');
  });

  it('load without an attached worker throws', async () => {
    await expect(useSimStore.getState().load()).rejects.toThrow(/not attached/);
  });

  it('transport actions and sync are no-ops while unattached', async () => {
    const store = useSimStore.getState();
    await store.play();
    await store.pause();
    await store.step();
    await store.seek(0);
    await store.setSpeed(2);
    await store.syncStatus();
    expect(useSimStore.getState().status.state).toBe('idle');
  });

  it('attaches a worker, loads, and builds a ring per entity kind', async () => {
    useSimStore.getState().attach(new MockSimRunner());
    await useSimStore.getState().load();
    const s = useSimStore.getState();
    expect(s.ready).toBe(true);
    expect([...s.rings.keys()].sort()).toEqual(['backend', 'client', 'envoy']);
    expect(s.rings.get('envoy')?.size()).toBe(1);
    expect(s.status.state).toBe('paused');
  });

  it('proxies transport controls to the worker and mirrors status', async () => {
    useSimStore.getState().attach(new MockSimRunner());
    await useSimStore.getState().load({
      ...defaultSimConfig(),
      time: { durationMs: 100, sampleIntervalMs: 10 },
    });
    await useSimStore.getState().step();
    expect(useSimStore.getState().status.virtualTimeMs).toBe(10);
    await useSimStore.getState().seek(50);
    expect(useSimStore.getState().status.virtualTimeMs).toBe(50);
    await useSimStore.getState().setSpeed(2);
    await useSimStore.getState().play();
    expect(useSimStore.getState().status.state).toBe('running');
    await useSimStore.getState().pause();
    expect(useSimStore.getState().status.state).toBe('paused');
  });

  it('setConfig replaces the draft without reloading', () => {
    const next = { ...defaultSimConfig(), seed: 42 };
    useSimStore.getState().setConfig(next);
    expect(useSimStore.getState().config.seed).toBe(42);
    expect(useSimStore.getState().ready).toBe(false);
  });
});
