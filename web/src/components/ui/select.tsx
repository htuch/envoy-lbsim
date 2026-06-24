import type { SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * A styled native `<select>`. Native is deliberate: it is keyboard- and
 * screen-reader-accessible for free, needs no portal/Radix dependency, and suits
 * the small enumerations the config editor exposes (policy kind, arrival kind).
 */
export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: ReadonlyArray<{ value: string; label: string }>;
}

export function Select({ className, options, ...props }: SelectProps): React.JSX.Element {
  return (
    <select
      className={cn(
        'h-7 rounded-md border border-input bg-background px-2 text-xs',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        'disabled:pointer-events-none disabled:opacity-40',
        className,
      )}
      {...props}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
