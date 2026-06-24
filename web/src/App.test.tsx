import { defaultSimConfig } from '@elbsim/config';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App';

describe('App shell', () => {
  it('renders the title and the default scenario summary', () => {
    render(<App />);
    expect(screen.getByText('Envoy LB Simulator')).toBeInTheDocument();

    const cfg = defaultSimConfig();
    // Envoy count and policy appear in the config summary.
    expect(
      screen.getByText(new RegExp(`${cfg.envoys.count}.*${cfg.envoys.policy.kind}`)),
    ).toBeInTheDocument();
    expect(screen.getByText(`${cfg.timeouts.requestTimeoutMs} ms`)).toBeInTheDocument();
  });
});
