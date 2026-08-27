import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../useStore';

describe('banksKnown', () => {
  beforeEach(() => {
    useStore.setState({ banks: Array(10).fill(true), banksKnown: false });
  });

  it('starts unknown, because the default mask is a guess not a reading', () => {
    expect(useStore.getState().banksKnown).toBe(false);
  });

  it('becomes known after a well-formed mask arrives', () => {
    const mask = [true, true, true, true, true, true, true, false, false, false];
    useStore.getState().setBanks(mask);
    expect(useStore.getState().banksKnown).toBe(true);
    expect(useStore.getState().banks).toEqual(mask);
  });

  /**
   * A malformed reply must not mark the state known. It falls back to the
   * all-enabled placeholder, and a placeholder claiming to be a reading is
   * exactly the bug #393 describes.
   */
  it('stays unknown when the reply is the wrong length', () => {
    useStore.getState().setBanks([true, false]);
    expect(useStore.getState().banksKnown).toBe(false);
    expect(useStore.getState().banks).toEqual(Array(10).fill(true));
  });
});
