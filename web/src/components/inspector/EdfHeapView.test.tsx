import type { EdfInspection } from '@elbsim/protocol';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EdfHeapView } from './EdfHeapView';

describe('EdfHeapView', () => {
  it('renders the heap with the next pick and any prepick list', () => {
    const edf: EdfInspection = {
      kind: 'edf',
      currentTime: 1.5,
      entries: [
        { backend: 0, deadline: 2, weight: 1 },
        { backend: 1, deadline: 3, weight: 0.5 },
      ],
      prepick: [2, 3],
    };
    render(<EdfHeapView edf={edf} />);
    expect(screen.getByText(/current_time/)).toBeInTheDocument();
    expect(screen.getByText('next')).toBeInTheDocument();
    expect(screen.getByText('b2 b3')).toBeInTheDocument();
  });

  it('reports an empty heap when there are no entries', () => {
    const edf: EdfInspection = { kind: 'edf', currentTime: 0, entries: [], prepick: [] };
    render(<EdfHeapView edf={edf} />);
    expect(screen.getByText(/Heap empty/)).toBeInTheDocument();
  });
});
