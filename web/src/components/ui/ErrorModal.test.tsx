import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSimStore } from '@/store/sim-store';
import { ErrorModal } from './ErrorModal';

function reset(): void {
  useSimStore.setState(useSimStore.getInitialState(), true);
}

describe('ErrorModal', () => {
  beforeEach(reset);
  afterEach(reset);

  it('renders nothing when there is no error', () => {
    render(<ErrorModal />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders the message and focuses the dismiss button when store.error is set', () => {
    useSimStore.getState().raiseError('Boom: table size must be prime');
    render(<ErrorModal />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Boom: table size must be prime')).toBeInTheDocument();
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    expect(dismiss).toHaveFocus();
  });

  it('clears the error when Dismiss is clicked', () => {
    useSimStore.getState().raiseError('boom');
    render(<ErrorModal />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(useSimStore.getState().error).toBeNull();
  });

  it('clears the error on Escape but ignores other keys', () => {
    useSimStore.getState().raiseError('boom');
    render(<ErrorModal />);
    // A non-Escape key must not dismiss.
    fireEvent.keyDown(window, { key: 'a' });
    expect(useSimStore.getState().error).toBe('boom');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useSimStore.getState().error).toBeNull();
  });

  it('clears the error on a backdrop click but not a card click', () => {
    useSimStore.getState().raiseError('boom');
    render(<ErrorModal />);
    // Clicking the card itself must not dismiss.
    fireEvent.click(screen.getByRole('dialog'));
    expect(useSimStore.getState().error).toBe('boom');
    // Clicking the backdrop (the dialog's parent) dismisses.
    const backdrop = screen.getByRole('dialog').parentElement as HTMLElement;
    fireEvent.click(backdrop);
    expect(useSimStore.getState().error).toBeNull();
  });
});
