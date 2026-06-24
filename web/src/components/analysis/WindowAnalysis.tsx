import * as Plot from '@observablehq/plot';
import { useMemo } from 'react';
import { computeWindowAggregate, type LatencyWindow } from '@/synthetic';
import { PlotFigure } from './PlotFigure';
import { latencyCdf, outcomeBreakdown } from './stats';

/** Accent for the distribution marks; matched to the instrument palette. */
const ACCENT = 'hsl(222 65% 52%)';

/**
 * Cold-path analytical view over a committed brushed window. Renders the latency
 * distribution (empirical CDF and histogram) and a goodput breakdown from the
 * window's completed-latency samples and outcome counts. In the real system the
 * window comes from the worker scanning the RequestEvent stream
 * (`queryWindow`); here it is the synthetic `LatencyWindow`.
 */
export function WindowAnalysis({ window }: { window: LatencyWindow }): React.JSX.Element {
  const agg = useMemo(() => computeWindowAggregate(window), [window]);
  const cdf = useMemo(() => latencyCdf(window.latencies), [window.latencies]);
  const breakdown = useMemo(() => outcomeBreakdown(agg), [agg]);

  const cdfOptions = useMemo<Plot.PlotOptions>(
    () => ({
      width: 560,
      height: 200,
      marginLeft: 52,
      marginBottom: 34,
      x: { label: 'latency (ms) →', grid: true },
      y: { label: '↑ P(X ≤ x)', domain: [0, 1], grid: true, tickFormat: '%' },
      marks: [
        Plot.areaY(cdf, { x: 'latency', y: 'p', fill: ACCENT, fillOpacity: 0.12 }),
        Plot.lineY(cdf, { x: 'latency', y: 'p', stroke: ACCENT, strokeWidth: 1.5 }),
        Plot.ruleX([agg.latencyP50, agg.latencyP90, agg.latencyP99], {
          stroke: 'currentColor',
          strokeOpacity: 0.25,
          strokeDasharray: '2,3',
        }),
      ],
    }),
    [cdf, agg],
  );

  const histOptions = useMemo<Plot.PlotOptions>(
    () => ({
      width: 560,
      height: 200,
      marginLeft: 52,
      marginBottom: 34,
      x: { label: 'latency (ms) →' },
      y: { label: '↑ count', grid: true },
      marks: [
        Plot.rectY(window.latencies, {
          ...Plot.binX({ y: 'count' }, { x: (d: number) => d, thresholds: 30 }),
          fill: ACCENT,
        }),
        Plot.ruleY([0]),
      ],
    }),
    [window.latencies],
  );

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto max-w-2xl space-y-4">
        <header className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold tracking-tight">Window analysis</h2>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {agg.fromMs}–{agg.toMs} ms · {agg.totalRequests} req
          </span>
        </header>

        {agg.totalRequests === 0 ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            No requests in the selected window.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-4 gap-2">
              <Stat label="goodput" value={`${(agg.goodput * 100).toFixed(1)}%`} />
              <Stat label="p50" value={`${agg.latencyP50.toFixed(1)} ms`} />
              <Stat label="p90" value={`${agg.latencyP90.toFixed(1)} ms`} />
              <Stat label="p99" value={`${agg.latencyP99.toFixed(1)} ms`} />
            </div>

            <section className="space-y-1.5">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Outcome breakdown
              </p>
              <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
                {breakdown.map((s) => (
                  <div
                    key={s.outcome}
                    title={`${s.outcome}: ${s.count}`}
                    style={{ width: `${s.fraction * 100}%`, background: s.color }}
                  />
                ))}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 pt-0.5">
                {breakdown.map((s) => (
                  <span key={s.outcome} className="flex items-center gap-1.5 text-xs">
                    <span
                      aria-hidden
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ background: s.color }}
                    />
                    <span className="text-muted-foreground">{s.outcome}</span>
                    <span className="font-mono tabular-nums">{s.count}</span>
                    <span className="font-mono tabular-nums text-muted-foreground">
                      {(s.fraction * 100).toFixed(1)}%
                    </span>
                  </span>
                ))}
              </div>
            </section>

            <Figure title="Latency CDF" options={cdfOptions} />
            <Figure title="Latency histogram" options={histOptions} />
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="rounded-md border bg-card px-2.5 py-1.5">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="font-mono text-sm tabular-nums">{value}</p>
    </div>
  );
}

function Figure({
  title,
  options,
}: {
  title: string;
  options: Plot.PlotOptions;
}): React.JSX.Element {
  return (
    <section className="space-y-1.5">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</p>
      <div className="overflow-x-auto rounded-md border bg-card p-2">
        <PlotFigure options={options} />
      </div>
    </section>
  );
}
