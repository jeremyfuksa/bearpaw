import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({ runDiagnostic: vi.fn() }));
vi.mock('../../../api/useApi', () => ({ getAPI: () => api, API_BASE: '/api/v1' }));

const shell = vi.hoisted(() => ({
  saveExport: vi.fn(() => Promise.resolve('browser' as const)),
  openExternalUrl: vi.fn(),
}));
vi.mock('../../../tauri-shell', () => shell);

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { DiagnosticSheet } from '../DiagnosticSheet';
import { buildIssueUrl, buildMailto } from '../diagnosticLinks';
import { APIError } from '../../../api/client';

const TEXT = 'Bearpaw diagnostic\nModel: SDS100\nMDL -> MDL,SDS100\nVER -> VER,1.02.00';

function reportResponse(text = TEXT) {
  return {
    report: {
      model: 'SDS100',
      firmware: '1.02.00',
      link: 'serial',
      bearpaw_version: '1.2.0',
      lines: [],
    },
    text,
  };
}

function renderSheet() {
  const onClose = vi.fn();
  render(<DiagnosticSheet isOpen model="SDS100" onClose={onClose} />);
  return { onClose };
}

const SEND_BUTTONS = ['Save report', 'Email it', 'Open an issue'];

describe('DiagnosticSheet', () => {
  beforeEach(() => {
    api.runDiagnostic.mockReset();
    shell.saveExport.mockClear();
    shell.openExternalUrl.mockClear();
  });

  it('the intro says it is read-only and that nothing is sent without review', () => {
    renderSheet();
    expect(
      screen.getByText(
        "This asks your SDS100 a few questions about how it works: its model, firmware, and current settings. It writes nothing to your scanner. You'll see the whole report before anything is sent, and you choose how to send it.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run diagnostic' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    // Nothing touches the radio until the user asks.
    expect(api.runDiagnostic).not.toHaveBeenCalled();
    for (const name of SEND_BUTTONS) expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it('Cancel closes without running anything', async () => {
    const { onClose } = renderSheet();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(api.runDiagnostic).not.toHaveBeenCalled();
  });

  it('the report is shown in full before any send option', async () => {
    let resolve!: (value: ReturnType<typeof reportResponse>) => void;
    api.runDiagnostic.mockReturnValue(new Promise((r) => (resolve = r)));
    renderSheet();
    await userEvent.click(screen.getByRole('button', { name: 'Run diagnostic' }));

    // While it runs: no report, no send buttons.
    expect(api.runDiagnostic).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Email it' })).toBeNull();
    expect(document.querySelector('pre')).toBeNull();

    resolve(reportResponse());
    const pre = await screen.findByText((_, el) => el?.tagName === 'PRE');
    expect(pre.textContent).toBe(TEXT);
    for (const name of SEND_BUTTONS) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('Save, Email it and Open an issue use the report and the built URLs', async () => {
    api.runDiagnostic.mockResolvedValue(reportResponse());
    renderSheet();
    await userEvent.click(screen.getByRole('button', { name: 'Run diagnostic' }));
    await screen.findByRole('button', { name: 'Email it' });

    await userEvent.click(screen.getByRole('button', { name: 'Email it' }));
    expect(shell.openExternalUrl).toHaveBeenLastCalledWith(buildMailto(TEXT, 'SDS100'));
    await userEvent.click(screen.getByRole('button', { name: 'Open an issue' }));
    expect(shell.openExternalUrl).toHaveBeenLastCalledWith(buildIssueUrl(TEXT, 'SDS100'));

    await userEvent.click(screen.getByRole('button', { name: 'Save report' }));
    expect(shell.saveExport).toHaveBeenCalledTimes(1);
    const [filename, bytes] = shell.saveExport.mock.calls[0] as unknown as [string, Uint8Array];
    expect(filename).toMatch(/^bearpaw-diagnostic-SDS100-\d{4}-\d{2}-\d{2}\.txt$/);
    expect(new TextDecoder().decode(bytes)).toBe(TEXT);
  });

  it('a failed run shows an error and no send buttons', async () => {
    api.runDiagnostic.mockRejectedValue(new APIError('sync_in_progress', 409, {}));
    renderSheet();
    await userEvent.click(screen.getByRole('button', { name: 'Run diagnostic' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/reading the scanner's memory/i)).toBeInTheDocument();
    for (const name of SEND_BUTTONS) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(document.querySelector('pre')).toBeNull();
    // The user can try again.
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('an unexpected failure still shows a plain error', async () => {
    api.runDiagnostic.mockRejectedValue(new Error('network down'));
    renderSheet();
    await userEvent.click(screen.getByRole('button', { name: 'Run diagnostic' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/didn't finish/i);
  });

  it('reopening the sheet starts again at the intro', async () => {
    api.runDiagnostic.mockResolvedValue(reportResponse());
    const { rerender } = render(<DiagnosticSheet isOpen model="SDS100" onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Run diagnostic' }));
    await screen.findByRole('button', { name: 'Email it' });
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    rerender(<DiagnosticSheet isOpen={false} model="SDS100" onClose={() => {}} />);
    rerender(<DiagnosticSheet isOpen model="SDS100" onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Email it' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Run diagnostic' })).toBeInTheDocument();
  });
});
