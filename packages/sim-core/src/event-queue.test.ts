import { describe, expect, it } from 'vitest';
import { EventQueue } from './event-queue';

describe('EventQueue', () => {
  it('pops events in time order', () => {
    const q = new EventQueue<string>();
    q.schedule(30, 'c');
    q.schedule(10, 'a');
    q.schedule(20, 'b');
    expect(q.size).toBe(3);
    expect(q.pop()?.payload).toBe('a');
    expect(q.pop()?.payload).toBe('b');
    expect(q.pop()?.payload).toBe('c');
    expect(q.pop()).toBeUndefined();
  });

  it('breaks ties by insertion order (FIFO)', () => {
    const q = new EventQueue<number>();
    for (let i = 0; i < 5; i++) q.schedule(100, i);
    const order = [
      q.pop()?.payload,
      q.pop()?.payload,
      q.pop()?.payload,
      q.pop()?.payload,
      q.pop()?.payload,
    ];
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('reports peek time and emptiness', () => {
    const q = new EventQueue<string>();
    expect(q.isEmpty()).toBe(true);
    expect(q.peekTime()).toBeUndefined();
    q.schedule(5, 'x');
    expect(q.isEmpty()).toBe(false);
    expect(q.peekTime()).toBe(5);
  });

  it('handles interleaved heap operations correctly', () => {
    const q = new EventQueue<number>();
    const times = [50, 17, 92, 3, 28, 64, 11, 80, 45, 6];
    times.forEach((t, i) => {
      q.schedule(t, i);
    });
    const popped: number[] = [];
    while (!q.isEmpty()) popped.push(q.pop()?.time as number);
    expect(popped).toEqual([...times].sort((a, b) => a - b));
  });

  it('rejects non-finite times', () => {
    const q = new EventQueue<string>();
    expect(() => q.schedule(Number.NaN, 'x')).toThrow();
    expect(() => q.schedule(Number.POSITIVE_INFINITY, 'x')).toThrow();
  });
});
