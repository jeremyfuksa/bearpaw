import { afterEach, describe, expect, it, vi } from 'vitest';
import { ask } from '@tauri-apps/plugin-dialog';
import { confirmDialog } from '../tauri-shell';

vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn().mockResolvedValue(true),
  open: vi.fn(),
  save: vi.fn(),
}));

// Every caller's test mocks `confirmDialog` itself, so nothing else would
// notice it dropping `okLabel`: the priority dialogs (#605) would quietly go
// back to a "Yes" button while their tests stayed green.
describe('confirmDialog under Tauri', () => {
  afterEach(() => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('passes the confirm button label to the native dialog', async () => {
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

    await confirmDialog(
      'Bank 1 will have no priority channel.',
      'Clear priority',
      'Clear priority',
    );

    expect(ask).toHaveBeenCalledWith('Bank 1 will have no priority channel.', {
      title: 'Clear priority',
      kind: 'warning',
      okLabel: 'Clear priority',
    });
  });
});
