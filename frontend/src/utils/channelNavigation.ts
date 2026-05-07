import type { ScannerAPIClient } from '../api/client';
import { useStore } from '../store/useStore';

const STEP_DELAY_MS = 80;
const HOLD_TIMEOUT_MS = 800;

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitForHold() {
  const start = Date.now();
  while (Date.now() - start < HOLD_TIMEOUT_MS) {
    const mode = (useStore.getState().liveState?.mode ?? '').toString().toUpperCase();
    if (mode === 'HOLD') return true;
    await wait(60);
  }
  return false;
}

export async function stepToChannel(
  api: ScannerAPIClient,
  currentChannel: number | null | undefined,
  targetChannel: number,
) {
  try {
    if (!currentChannel || currentChannel === targetChannel) {
      await api.sendHold();
      return true;
    }
    const direction = targetChannel > currentChannel ? 'UP' : 'DOWN';
    const steps = Math.abs(targetChannel - currentChannel);
    await api.sendHold();
    const inHold = await waitForHold();
    if (!inHold) {
      console.warn('Hold state not reached before stepping');
      return false;
    }
    for (let idx = 0; idx < steps; idx += 1) {
      try {
        await api.sendKey(direction);
      } catch (error) {
        console.warn('Channel step failed', error);
        return false;
      }
      await wait(STEP_DELAY_MS);
    }
    return true;
  } catch (error) {
    console.warn('Channel navigation failed', error);
    return false;
  }
}
