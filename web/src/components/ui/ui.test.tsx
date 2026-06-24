import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './button';
import { Field } from './field';
import { NumberInput } from './number-input';
import { Select } from './select';

describe('Button', () => {
  it('renders children and fires onClick', () => {
    const onClick = vi.fn();
    render(
      <Button variant="outline" onClick={onClick}>
        Go
      </Button>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('Field', () => {
  it('labels its control', () => {
    render(
      <Field label="Seed" htmlFor="x" hint="the prng seed">
        <input id="x" />
      </Field>,
    );
    expect(screen.getByText('Seed')).toBeInTheDocument();
    expect(screen.getByLabelText('Seed')).toBeInTheDocument();
  });
});

describe('Select', () => {
  it('renders options and reports the chosen value', () => {
    const onChange = vi.fn();
    render(
      <Select
        aria-label="pick"
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ]}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText('pick'), { target: { value: 'b' } });
    expect(onChange).toHaveBeenCalledOnce();
    expect(screen.getByRole('option', { name: 'A' })).toBeInTheDocument();
  });
});

describe('NumberInput', () => {
  it('emits parsed numbers and ignores non-numeric entry', () => {
    const onValueChange = vi.fn();
    render(<NumberInput value={5} onValueChange={onValueChange} />);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '12' } });
    expect(onValueChange).toHaveBeenLastCalledWith(12);
    fireEvent.change(input, { target: { value: '' } });
    expect(onValueChange).toHaveBeenCalledOnce(); // NaN ignored
  });
});
