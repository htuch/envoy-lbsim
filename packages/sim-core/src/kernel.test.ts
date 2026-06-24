import { describe, expect, it } from 'vitest';
import { SimKernel } from './kernel';

describe('SimKernel', () => {
  it('dispatches events in time order, advancing the clock', () => {
    const fired: Array<{ t: number; p: string }> = [];
    const k = new SimKernel<string>((e, kernel) => fired.push({ t: kernel.now(), p: e.payload }));
    k.scheduleAt(30, 'c');
    k.scheduleAt(10, 'a');
    k.scheduleAt(20, 'b');
    const n = k.runUntil(25);
    expect(n).toBe(2);
    expect(fired).toEqual([
      { t: 10, p: 'a' },
      { t: 20, p: 'b' },
    ]);
    expect(k.now()).toBe(25); // clock advances to the horizon
    expect(k.hasWork()).toBe(true);
  });

  it('lets handlers schedule follow-up events', () => {
    let count = 0;
    const k = new SimKernel<number>((e, kernel) => {
      count++;
      if (e.payload < 3) kernel.scheduleAfter(10, e.payload + 1);
    });
    k.scheduleAt(0, 0);
    k.runToCompletion();
    expect(count).toBe(4); // 0 -> 1 -> 2 -> 3
    expect(k.now()).toBe(30);
  });

  it('scheduleAfter offsets from the current clock', () => {
    const seen: number[] = [];
    const k = new SimKernel<string>((_e, kernel) => seen.push(kernel.now()));
    k.scheduleAt(100, 'tick');
    k.runUntil(100);
    expect(seen).toEqual([100]);
  });

  it('rejects scheduling into the past and negative delays', () => {
    const k = new SimKernel<string>(() => {});
    k.scheduleAt(50, 'x');
    k.runUntil(50);
    expect(() => k.scheduleAt(10, 'y')).toThrow(/past/);
    expect(() => k.scheduleAfter(-1, 'y')).toThrow(/non-negative/);
  });

  it('runUntil on an empty queue just advances the clock', () => {
    const k = new SimKernel<string>(() => {});
    expect(k.runUntil(42)).toBe(0);
    expect(k.now()).toBe(42);
  });
});
