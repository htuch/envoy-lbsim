import { cn } from '@/lib/utils';

/**
 * A compact numeric input that emits parsed numbers (not strings) and ignores
 * non-numeric entry. Tabular-aligned to match the panel's instrument aesthetic.
 */
export function NumberInput({
  id,
  value,
  onValueChange,
  min,
  max,
  step,
  className,
}: {
  id?: string;
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
}): React.JSX.Element {
  return (
    <input
      id={id}
      type="number"
      inputMode="decimal"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        const n = e.target.valueAsNumber;
        if (!Number.isNaN(n)) onValueChange(n);
      }}
      className={cn(
        'h-7 w-24 rounded-md border border-input bg-background px-2 text-right font-mono text-xs tabular-nums',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        className,
      )}
    />
  );
}
