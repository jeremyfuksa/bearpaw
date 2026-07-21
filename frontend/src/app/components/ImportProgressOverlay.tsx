import { AnimatePresence, motion } from 'motion/react';
import { SyncSpinner } from './SyncSpinner';

interface ImportProgressOverlayProps {
  active: boolean;
  percent: number;
  message: string;
}

/**
 * Full-screen blocking overlay shown while a channel/config import runs
 * (~80s of wire writes). Mirrors the memory-sync overlay's look but is driven
 * by the SEPARATE `importProgress` store slice — no cancel button (cancelling
 * mid-PRG-bracket would leave a partial config).
 */
export function ImportProgressOverlay({ active, percent, message }: ImportProgressOverlayProps) {
  return (
    <AnimatePresence>
      {active && (
        <motion.div
          key="import-progress-overlay"
          role="status"
          aria-live="polite"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
        >
          <div className="flex max-w-sm flex-col items-center gap-4 rounded-lg border border-white/10 bg-scanner-bg-dark p-6 shadow-lg">
            <SyncSpinner percent={percent} size={56} />
            <div className="flex flex-col items-center gap-1">
              <span className="text-sm font-medium text-white">Importing</span>
              <span className="font-mono text-xs text-scanner-text-secondary">
                {Math.round(percent)}%
              </span>
            </div>
            <p className="text-center text-xs text-scanner-text-secondary">
              {message || 'Writing to scanner…'}
            </p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
