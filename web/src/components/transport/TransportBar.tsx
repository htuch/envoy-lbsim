import { Pause, Play, RotateCcw, StepForward, ZoomOut } from 'lucide-react';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { useSimStore } from '@/store/sim-store';

/**
 * Playback transport: play/pause, single-step, reset-to-start, a speed selector,
 * and a scrubbable seek track with a virtual-time readout. While running it
 * polls the worker for authoritative status at a low rate (the 60fps data path
 * is the ring buffers, not this); the slider and clock read from that status.
 */
const SPEEDS = [0.25, 0.5, 1, 2, 4, 8] as const;
const SYNC_MS = 100;

function fmtSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

export function TransportBar(): React.JSX.Element {
  const status = useSimStore((s) => s.status);
  const duration = useSimStore((s) => s.config.time.durationMs);
  const sampleInterval = useSimStore((s) => s.config.time.sampleIntervalMs);
  const ready = useSimStore((s) => s.ready);
  const play = useSimStore((s) => s.play);
  const pause = useSimStore((s) => s.pause);
  const step = useSimStore((s) => s.step);
  const seek = useSimStore((s) => s.seek);
  const setSpeed = useSimStore((s) => s.setSpeed);
  const syncStatus = useSimStore((s) => s.syncStatus);
  const selection = useSimStore((s) => s.selection);
  const setSelection = useSimStore((s) => s.setSelection);

  const running = status.state === 'running';
  const finished = status.state === 'finished';

  // Mirror worker status at a low cadence while running; the timelines render
  // off shared memory independently of this.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => void syncStatus(), SYNC_MS);
    return () => clearInterval(id);
  }, [running, syncStatus]);

  return (
    <div className="flex items-center gap-3 border-t bg-card px-3 py-2">
      <div className="flex items-center gap-1">
        <Button
          size="icon"
          variant="default"
          disabled={!ready || finished}
          aria-label={running ? 'Pause' : 'Play'}
          onClick={() => void (running ? pause() : play())}
        >
          {running ? <Pause size={14} /> : <Play size={14} />}
        </Button>
        <Button
          size="icon"
          variant="outline"
          disabled={!ready || running || finished}
          aria-label="Step one sample interval"
          onClick={() => void step()}
        >
          <StepForward size={14} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          disabled={!ready}
          aria-label="Reset to start"
          onClick={() => void seek(0)}
        >
          <RotateCcw size={14} />
        </Button>
      </div>

      {/* Seek scrubber with an optional committed-window band overlay. The band
          marks the brushed window over [0, duration]; pointer-events-none keeps
          the slider beneath it fully interactive. */}
      <div className="relative flex min-w-0 flex-1 items-center">
        {selection && (
          <div
            data-window-band
            className="pointer-events-none absolute top-1/2 h-1 -translate-y-1/2 rounded-sm bg-primary/30 ring-1 ring-primary/60"
            style={{
              left: `${(selection.fromMs / duration) * 100}%`,
              width: `${((selection.toMs - selection.fromMs) / duration) * 100}%`,
            }}
          />
        )}
        <input
          type="range"
          aria-label="Seek"
          className="h-1 min-w-0 flex-1 accent-primary"
          min={0}
          max={duration}
          step={sampleInterval}
          value={Math.min(status.virtualTimeMs, duration)}
          disabled={!ready}
          onChange={(e) => void seek(e.target.valueAsNumber)}
        />
      </div>

      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
        {fmtSeconds(status.virtualTimeMs)} / {fmtSeconds(duration)}
      </span>

      {selection && (
        <Button
          variant="outline"
          aria-label="Reset zoom"
          title="Clear the brushed window"
          onClick={() => setSelection(null)}
        >
          <ZoomOut size={12} />
          <span className="font-mono tabular-nums">
            {(selection.fromMs / 1000).toFixed(2)}–{(selection.toMs / 1000).toFixed(2)}s
          </span>
        </Button>
      )}

      <Select
        aria-label="Playback speed"
        className="w-20"
        disabled={!ready}
        defaultValue="1"
        options={SPEEDS.map((s) => ({ value: String(s), label: `${s}×` }))}
        onChange={(e) => void setSpeed(Number(e.target.value))}
      />
    </div>
  );
}
