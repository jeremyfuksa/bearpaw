import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../useStore';
import { createTestChannel, createTestDeviceInfo } from '../../test/fixtures/data';
import { buildDraft } from '../../app/components/views/ChannelsTab';

// REGRESSION GUARD (#791): drafts are keyed by slot index only, so a draft
// made on one scanner was diffed against -- and uploaded onto -- whichever
// scanner connected next. A swap mid-session (new in 1.2.0) must drop them.
const draft = buildDraft(createTestChannel({ index: 1, frequency: 155.5 }), 2);
const connect = (scanner_id: string | null) =>
  useStore.getState().setDeviceInfo(createTestDeviceInfo({ scanner_id }));

describe('channel drafts belong to the scanner they were made on', () => {
  beforeEach(() => {
    useStore.setState({ deviceInfo: null, draftScannerId: null, memoryDrafts: {} });
  });

  it('drops the drafts when a different scanner connects', () => {
    connect('scanner-a');
    useStore.getState().setMemoryDraft(1, draft);
    connect('scanner-b');
    expect(useStore.getState().memoryDrafts).toEqual({});
    expect(useStore.getState().draftScannerId).toBe('scanner-b');
  });

  // The positive half: without it, a build that clears on EVERY device_info
  // update -- each reconnect, each rename -- passes the guard above.
  it('keeps the drafts when the same scanner reconnects or loses its id', () => {
    connect('scanner-a');
    useStore.getState().setMemoryDraft(1, draft);
    connect('scanner-a');
    connect(null);
    useStore.getState().setDeviceInfo(null);
    connect('scanner-a');
    expect(useStore.getState().memoryDrafts).toEqual({ 1: draft });
  });

  it('keeps drafts made before the first scanner identified itself', () => {
    useStore.getState().setMemoryDraft(1, draft);
    connect('scanner-a');
    expect(useStore.getState().memoryDrafts).toEqual({ 1: draft });
  });
});
