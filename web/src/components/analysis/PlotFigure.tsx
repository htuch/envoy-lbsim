import * as Plot from '@observablehq/plot';
import { useEffect, useRef } from 'react';

/**
 * Render an Observable Plot spec into the DOM from React. Plot builds a detached
 * SVG/HTML node imperatively, so we append it to a ref and replace it whenever
 * the (caller-memoized) options change. The cold path re-renders on
 * window-commit, never per frame, so this imperative bridge is cheap.
 */
export function PlotFigure({ options }: { options: Plot.PlotOptions }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = Plot.plot(options);
    el.append(chart);
    return () => chart.remove();
  }, [options]);

  return <div ref={ref} />;
}
