import { motion } from 'motion/react';

interface BearpawProgressProps {
  /** 0–100. Each 20% increment opens one toe. */
  percent: number;
  /** Rendered pixel size for the square SVG. Defaults to 96. */
  size?: number;
  className?: string;
}

const PAD = { cx: 50, cy: 68, rx: 22, ry: 18 } as const;

/**
 * Five toes laid out in an arc above the pad, going left → right. Each
 * has its own `rx`/`ry` so the outer toes can be slightly smaller — keeps
 * the silhouette readable at the icon scale. `threshold` is the percent
 * at which this toe *starts* opening; it finishes 20 points later.
 */
const TOES = [
  { cx: 22, cy: 44, rx: 6, ry: 8, threshold: 0 },
  { cx: 34, cy: 30, rx: 7, ry: 9, threshold: 20 },
  { cx: 50, cy: 24, rx: 8, ry: 10, threshold: 40 },
  { cx: 66, cy: 30, rx: 7, ry: 9, threshold: 60 },
  { cx: 78, cy: 44, rx: 6, ry: 8, threshold: 80 },
] as const;

export function BearpawProgress({ percent, size = 96, className }: BearpawProgressProps) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label={`Memory sync ${Math.round(clamped)}% complete`}
      className={className}
    >
      <defs>
        <radialGradient id="bp-pad-grad" cx="50%" cy="35%" r="65%">
          <stop offset="0%" stopColor="var(--bp-loader-highlight, oklch(0.78 0.16 30))" />
          <stop offset="100%" stopColor="var(--bp-loader-base, oklch(0.55 0.18 30))" />
        </radialGradient>
        <filter id="bp-pad-shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="1.5" stdDeviation="1.2" floodOpacity="0.35" />
        </filter>
      </defs>

      <g filter="url(#bp-pad-shadow)">
        {/* Main pad — always rendered at full size. */}
        <ellipse cx={PAD.cx} cy={PAD.cy} rx={PAD.rx} ry={PAD.ry} fill="url(#bp-pad-grad)" />

        {TOES.map((toe, i) => {
          // Per-toe progress: 0 → toe sits inside the pad (scale 0). 1 →
          // toe is at its open position at full size.
          const t = Math.max(0, Math.min(1, (clamped - toe.threshold) / 20));

          // Vector from open position back toward the pad center. When
          // t=0 the toe is fully translated onto the pad center; as t→1
          // the translation shrinks to zero so the toe lands at its
          // resting spot.
          const dx = (PAD.cx - toe.cx) * (1 - t);
          const dy = (PAD.cy - toe.cy) * (1 - t);

          return (
            <motion.ellipse
              key={i}
              cx={toe.cx}
              cy={toe.cy}
              rx={toe.rx}
              ry={toe.ry}
              fill="url(#bp-pad-grad)"
              style={{ originX: `${toe.cx}px`, originY: `${toe.cy}px` }}
              animate={{ x: dx, y: dy, scale: t, opacity: t * 0.85 + 0.15 }}
              transition={{ type: 'spring', stiffness: 220, damping: 22, mass: 0.6 }}
            />
          );
        })}
      </g>
    </svg>
  );
}
