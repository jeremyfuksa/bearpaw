import type { CSSProperties } from 'react';
import { syncPawSegments } from './syncPawPaths';
import './SyncPaw.css';

export type SyncOutcome = 'success' | 'cancelled' | 'error';

interface SyncPawProps {
  percent: number;
  outcome?: SyncOutcome;
  size?: number;
  reducedMotion?: boolean;
}

/** Outlines show progress; only an explicit successful outcome fills the paw. */
export function SyncPaw({ percent, outcome, size = 56, reducedMotion = false }: SyncPawProps) {
  const progress =
    outcome === 'success'
      ? 100
      : Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const label =
    outcome === 'success'
      ? 'Memory sync complete'
      : outcome === 'cancelled'
        ? 'Memory sync cancelled'
        : outcome === 'error'
          ? 'Memory sync failed'
          : `Memory sync ${Math.round(progress)}% complete`;
  return (
    <svg
      viewBox="-8 0 140 140"
      width={size}
      height={size}
      role="img"
      aria-label={label}
      className="sync-paw"
      data-outcome={outcome}
      data-reduced-motion={reducedMotion || undefined}
    >
      {syncPawSegments.map((segment, index) => (
        <g
          key={segment.name}
          data-segment={segment.name}
          className={`sync-paw__segment${(index === 0 ? progress > 0 : progress >= index * 20) ? ' is-lit' : ''}`}
          style={{ '--fill-delay': `${index * 70}ms` } as CSSProperties}
        >
          <g className="sync-paw__off">
            {segment.paths.map((d, i) => (
              <path key={i} d={d} />
            ))}
          </g>
          <g className="sync-paw__light">
            {segment.paths.map((d, i) => (
              <path key={i} d={d} />
            ))}
          </g>
        </g>
      ))}
      {outcome === 'error' && (
        <g
          className="sync-paw__error"
          fill="none"
          strokeWidth="10"
          strokeLinecap="round"
          transform="translate(0 22)"
        >
          <circle cx="62" cy="70" r="42" />
          <path d="M32.3 40.3L91.7 99.7" />
        </g>
      )}
    </svg>
  );
}
