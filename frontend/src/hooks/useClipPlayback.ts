import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { API_BASE } from '../api/useApi';

/**
 * Plays a queue of hit recordings, one after another, through one `<audio>`
 * element (#927). The queue is fixed when `play` is called, so a hit that
 * joins a rolled-up row mid-playback is not added to it.
 *
 * Playback stops when the queue ends, when `stop` is called, when another
 * queue starts, and when the caller unmounts.
 */
export function useClipPlayback() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [current, setCurrent] = useState<{ queue: string[]; index: number } | null>(null);

  const play = useCallback((queue: string[]) => {
    if (queue.length > 0) setCurrent({ queue, index: 0 });
  }, []);
  const stop = useCallback(() => setCurrent(null), []);

  useEffect(() => {
    if (!current) return;
    audioRef.current ??= new Audio();
    const audio = audioRef.current;
    const uid = current.queue[current.index];
    audio.src = `${API_BASE}/hits/${encodeURIComponent(uid)}/audio`;

    const next = () =>
      setCurrent((prev) =>
        prev && prev.index + 1 < prev.queue.length ? { ...prev, index: prev.index + 1 } : null,
      );
    // One id, so a failure reported by both the element and play() toasts once.
    const fail = () => {
      toast.error('Could not play this recording.', { id: 'clip-playback' });
      setCurrent(null);
    };
    audio.addEventListener('ended', next);
    audio.addEventListener('error', fail);
    audio.play().catch((error: unknown) => {
      // The cleanup below pausing a clip that is still loading rejects play()
      // with AbortError. That is a stop, not a failure.
      if (!(error instanceof DOMException && error.name === 'AbortError')) fail();
    });

    return () => {
      audio.removeEventListener('ended', next);
      audio.removeEventListener('error', fail);
      audio.pause();
    };
  }, [current]);

  return { playingUid: current ? current.queue[current.index] : null, play, stop };
}
