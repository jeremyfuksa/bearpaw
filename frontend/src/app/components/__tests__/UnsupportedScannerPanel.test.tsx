import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UnsupportedScannerPanel } from '../UnsupportedScannerPanel';

const noop = () => {};

describe('UnsupportedScannerPanel', () => {
  it('shows the model and both sentences', () => {
    render(
      <UnsupportedScannerPanel
        model="SDS100"
        dismissed={false}
        onRunDiagnostic={noop}
        onDismiss={noop}
        onSeeSupported={noop}
      />,
    );
    expect(
      screen.getByText('Bearpaw found your SDS100, which is currently unsupported.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('A safe, read-only diagnostic on your scanner can help fix that.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run diagnostic' })).toBeInTheDocument();
  });

  it('Not now calls onDismiss and offers no quit', async () => {
    const onDismiss = vi.fn();
    render(
      <UnsupportedScannerPanel
        model="SDS100"
        dismissed={false}
        onRunDiagnostic={noop}
        onDismiss={onDismiss}
        onSeeSupported={noop}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /quit|close app/i })).toBeNull();
  });

  it('the resting state asks nothing', () => {
    render(
      <UnsupportedScannerPanel
        model="SDS100"
        dismissed
        onRunDiagnostic={noop}
        onDismiss={noop}
        onSeeSupported={noop}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull();
    expect(
      screen.queryByText('A safe, read-only diagnostic on your scanner can help fix that.'),
    ).toBeNull();
    expect(
      screen.getByText('Bearpaw found your SDS100, which is currently unsupported.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run diagnostic' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'See supported scanners' })).toBeInTheDocument();
  });

  it('offers no Run diagnostic until a handler is supplied', () => {
    const { rerender } = render(
      <UnsupportedScannerPanel
        model="SDS100"
        dismissed={false}
        onDismiss={noop}
        onSeeSupported={noop}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Run diagnostic' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
    rerender(
      <UnsupportedScannerPanel model="SDS100" dismissed onDismiss={noop} onSeeSupported={noop} />,
    );
    expect(screen.queryByRole('button', { name: 'Run diagnostic' })).toBeNull();
    expect(screen.getByRole('button', { name: 'See supported scanners' })).toBeInTheDocument();
  });

  it('See supported scanners calls onSeeSupported', async () => {
    const onSeeSupported = vi.fn();
    render(
      <UnsupportedScannerPanel
        model="SDS100"
        dismissed
        onDismiss={noop}
        onSeeSupported={onSeeSupported}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'See supported scanners' }));
    expect(onSeeSupported).toHaveBeenCalledTimes(1);
  });
});
