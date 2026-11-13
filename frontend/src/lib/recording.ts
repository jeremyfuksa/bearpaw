/**
 * Whether a hit's recording can be played (#927). `partial` is a clip cut
 * short (the input dropped mid-hit, say) and still holds audio worth hearing;
 * `failed` and `too_short` have none, and anything else is not finished yet.
 */
export function isPlayableRecording(status: string | null | undefined): boolean {
  return status === 'ready' || status === 'partial';
}
