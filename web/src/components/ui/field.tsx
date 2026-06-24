import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A dense labeled control row for the config editor: label on the left, control
 * on the right, tabular alignment. Keeps the editor legible at high field
 * density without per-field markup noise.
 */
export function Field({
  label,
  htmlFor,
  hint,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn('flex items-center justify-between gap-3 py-1', className)}>
      <label htmlFor={htmlFor} className="shrink-0 text-xs text-muted-foreground" title={hint}>
        {label}
      </label>
      <div className="flex min-w-0 items-center gap-1.5">{children}</div>
    </div>
  );
}
