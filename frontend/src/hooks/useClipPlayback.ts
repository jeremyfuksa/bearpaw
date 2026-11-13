import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { API_BASE } from '../api/useApi';

/** One recording in a play queue. `duration` is the backend's length in
 *  seconds, 0 when it reported none. */
export interface Clip {
  uid: string;
  duration: number;
}

/** Where playback is in its queue. `elapsed` and `total` span the WHOLE
 *  queue, so a rolled-up row reads as one conversation (#927). */
export interface PlaybackPosition {
  uid: string;
  index: number;
  count: number;
  elapsed: number;
  total: number;
}

const sum = (clips: Clip[]) => clips.reduce((total, clip) => total + clip.duration, 0);

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
  const [current, setCurrent] = useState<{ queue: Clip[]; index: number } | null>(null);
  // Keyed by clip so a stale reading from the previous clip is never shown.
  const [clipTime, setClipTime] = useState<{ uid: string; time: number } | null>(null);

  const play = useCallback((queue: Clip[]) => {
    if (queue.length > 0) setCurrent({ queue, index: 0 });
  }, []);
  const stop = useCallback(() => setCurrent(null), []);

  useEffect(() => {
    if (!current) return;
    audioRef.current ??= new Audio();
    const audio = audioRef.current;
    const { uid } = current.queue[current.index];
    audio.src = `${API_BASE}/hits/${encodeURIComponent(uid)}/audio`;

    const next = () =>
      setCurrent((prev) =>
        prev && prev.index + 1 < prev.queue.length ? { ...prev, index: prev.index + 1 } : null,
      );
    const time = () => setClipTime({ uid, time: audio.currentTime });
    // One id, so a failure reported by both the element and play() toasts once.
    const fail = () => {
      toast.error('Could not play this recording.', { id: 'clip-playback' });
      setCurrent(null);
    };
    audio.addEventListener('ended', next);
    audio.addEventListener('timeupdate', time);
    audio.addEventListener('error', fail);
    audio.play().catch((error: unknown) => {
      // The cleanup below pausing a clip that is still loading rejects play()
      // with AbortError. That is a stop, not a failure.
      if (!(error instanceof DOMException && error.name === 'AbortError')) fail();
    });

    return () => {
      audio.removeEventListener('ended', next);
      audio.removeEventListener('timeupdate', time);
      audio.removeEventListener('error', fail);
      audio.pause();
    };
  }, [current]);

  let position: PlaybackPosition | null = null;
  if (current) {
    const { queue, index } = current;
    const { uid } = queue[index];
    const total = sum(queue);
    const inClip = clipTime?.uid === uid ? clipTime.time : 0;
    position = {
      uid,
      index,
      count: queue.length,
      elapsed: Math.min(total, sum(queue.slice(0, index)) + inClip),
      total,
    };
  }

  return { position, play, stop };
}
