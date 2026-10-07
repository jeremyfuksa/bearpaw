/**
 * "Bank 4 · Work" for a named bank, "Bank 4" otherwise.
 *
 * `bank` is 1-based; `names` is the store's `bankNames`, which may be shorter
 * than the bank count before the first read.
 */
export function bankLabel(bank: number, names: string[]): string {
  const name = names[bank - 1];
  return name ? `Bank ${bank} · ${name}` : `Bank ${bank}`;
}
