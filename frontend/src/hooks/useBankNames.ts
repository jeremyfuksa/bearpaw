import { useEffect } from 'react';
import { useStore } from '../store/useStore';

interface BankNamesApi {
  getBankNames: () => Promise<{ names: string[] }>;
}

/**
 * Keeps the store's `bankNames` matched to the connected scanner (#677).
 *
 * Names belong to one scanner profile, so they are cleared and refetched
 * whenever the profile changes: a different radio must not show the last
 * one's names. Keyed on the id alone, because it survives a disconnect, so a
 * replug of the same radio does not refetch. Lifted out of App.tsx so the
 * switch can be tested by mounting it.
 */
export function useBankNames(api: BankNamesApi): void {
  const scannerId = useStore((state) => state.deviceInfo?.scanner_id ?? null);
  const setBankNames = useStore((state) => state.setBankNames);

  useEffect(() => {
    setBankNames([]);
    if (!scannerId) return;
    let active = true;
    api
      .getBankNames()
      .then((result) => {
        if (active) setBankNames(result.names);
      })
      .catch((error) => console.warn('[BankNames] load failed', error));
    return () => {
      active = false;
    };
  }, [api, scannerId, setBankNames]);
}
