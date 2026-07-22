import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScanAnnouncer } from '../ScanAnnouncer';

/**
 * ScanAnnouncer emits ONE announcement per discrete transition and stays silent
 * on the ~5 Hz value churn. These tests lock in that edge-only behavior — the
 * balance between the silent extreme (C1) and the spam extreme (C2).
 */
describe('ScanAnnouncer', () => {
  const base = {
    squelchOpen: false,
    mode: 'SCAN',
    frequency: null as number | null,
    alphaTag: null as string | null,
    connectionStatus: 'connected' as const,
    isSyncing: false,
  };

  const region = () => screen.getByRole('status');

  it('says nothing on initial mount', () => {
    render(<ScanAnnouncer {...base} />);
    expect(region()).toHaveTextContent('');
  });

  it('announces a hit with frequency and tag on squelch open', () => {
    const { rerender } = render(<ScanAnnouncer {...base} />);
    rerender(<ScanAnnouncer {...base} squelchOpen={true} frequency={146.85} alphaTag="FIRE 1" />);
    expect(region()).toHaveTextContent('Hit — 146.850, FIRE 1');
  });

  it('announces "Scanning" when squelch closes again', () => {
    const { rerender } = render(<ScanAnnouncer {...base} squelchOpen={true} frequency={146.85} />);
    rerender(<ScanAnnouncer {...base} squelchOpen={false} frequency={146.85} />);
    expect(region()).toHaveTextContent('Scanning');
  });

  // C2 guard: while squelch stays open, the frequency/rssi churn must NOT
  // re-announce.
  it('does not re-announce while a hit persists across value churn', () => {
    const { rerender } = render(<ScanAnnouncer {...base} />);
    rerender(<ScanAnnouncer {...base} squelchOpen={true} frequency={146.85} alphaTag="FIRE 1" />);
    expect(region()).toHaveTextContent('Hit — 146.850, FIRE 1');
    // Same hit, later polls with a slightly different frequency reading.
    rerender(<ScanAnnouncer {...base} squelchOpen={true} frequency={146.851} alphaTag="FIRE 1" />);
    rerender(<ScanAnnouncer {...base} squelchOpen={true} frequency={146.852} alphaTag="FIRE 1" />);
    expect(region()).toHaveTextContent('Hit — 146.850, FIRE 1');
  });

  it('does not announce a hit in HOLD mode', () => {
    const { rerender } = render(<ScanAnnouncer {...base} mode="HOLD" />);
    rerender(<ScanAnnouncer {...base} mode="HOLD" squelchOpen={true} frequency={146.85} />);
    expect(region()).toHaveTextContent('');
  });

  it('announces connection disconnect and reconnect', () => {
    const { rerender } = render(<ScanAnnouncer {...base} connectionStatus="connected" />);
    rerender(<ScanAnnouncer {...base} connectionStatus="disconnected" />);
    expect(region()).toHaveTextContent('Disconnected');
    rerender(<ScanAnnouncer {...base} connectionStatus="connected" />);
    expect(region()).toHaveTextContent('Reconnected');
  });

  it('suppresses hit/scan announcements while syncing', () => {
    const { rerender } = render(<ScanAnnouncer {...base} isSyncing={true} />);
    rerender(<ScanAnnouncer {...base} isSyncing={true} squelchOpen={true} frequency={146.85} />);
    expect(region()).toHaveTextContent('');
  });
});
