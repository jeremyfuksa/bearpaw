interface SyncSpinnerProps {
  /** 0–100. Drives how far the progress arc sweeps. */
  percent: number;
  /** Rendered pixel size for the square SVG. Defaults to 56. */
  size?: number;
  className?: string;
}

const STROKE = 4;
const VIEW = 48;
const R = (VIEW - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * R;

/**
 * Determinate sync spinner: a faint track with an orange arc that sweeps
 * to `percent`. A slow ambient rotation gives it life; reduced-motion
 * users get the same arc without the spin.
 */
export function SyncSpinner({ percent, size = 56, className }: SyncSpinnerProps) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const offset = CIRCUMFERENCE * (1 - clamped / 100);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      role="img"
      aria-label={`Memory sync ${Math.round(clamped)}% complete`}
      className={className}
    >
      <g className="sync-spinner__spin" style={{ transformOrigin: 'center' }}>
        <circle
          cx={VIEW / 2}
          cy={VIEW / 2}
          r={R}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          className="text-white/10"
        />
        <circle
          cx={VIEW / 2}
          cy={VIEW / 2}
          r={R}
          fill="none"
          stroke="var(--bp-loader-base, oklch(0.7 0.17 45))"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${VIEW / 2} ${VIEW / 2})`}
          style={{ transition: 'stroke-dashoffset 0.3s ease' }}
        />
      </g>
    </svg>
  );
}
