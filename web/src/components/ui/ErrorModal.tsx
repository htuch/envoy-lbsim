import { AlertTriangle } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { buttonVariants } from '@/components/ui/button';
import { useSimStore } from '@/store/sim-store';

/**
 * A centered overlay modal that surfaces store `error` state: config-validation
 * and reload failures that would otherwise be silently swallowed. Renders only
 * when an error is present. Dismissable via the button, Escape, or a backdrop
 * click; the dismiss button takes focus on open so keyboard users land on the
 * action. Uses the light analytical card tokens to match the panel aesthetic.
 */
export function ErrorModal(): React.JSX.Element | null {
  const error = useSimStore((s) => s.error);
  const clearError = useSimStore((s) => s.clearError);
  const dismissRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!error) return;
    dismissRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') clearError();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [error, clearError]);

  if (!error) return null;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled globally above; the backdrop click is a convenience dismiss, not the sole keyboard path.
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm"
      onClick={clearError}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Error"
        className="w-full max-w-md rounded-lg border bg-card p-4 shadow-lg"
        // Clicks inside the card must not bubble to the backdrop dismiss.
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center gap-2 text-destructive">
          <AlertTriangle size={16} />
          <span className="text-xs font-semibold uppercase tracking-wider">Error</span>
        </div>
        <p className="mb-4 text-sm text-card-foreground">{error}</p>
        <div className="flex justify-end">
          <button
            ref={dismissRef}
            type="button"
            className={buttonVariants({ variant: 'outline' })}
            onClick={clearError}
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
