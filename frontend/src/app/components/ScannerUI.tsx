import React from 'react';
import { Usb } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Slider } from './ui/slider';
import usbSvgPaths from '../../imports/svg-4af8p5er03';
import socketSvgPaths from '../../imports/svg-10gl6kikm0';
import { FitText } from './FitText';

// --- Status Bar ---

export interface StatusBarSessionStats {
  total_hits?: number | null;
  unique_channels?: number | null;
  active_time_seconds?: number | null;
}

interface StatusBarProps {
  connectionStatus: 'connected' | 'connecting' | 'disconnected';
  modelName?: string;
  shellStatusText?: string | null;
  currentTab: string;
  sessionStats?: StatusBarSessionStats | null;
}

function formatActiveDuration(totalSeconds?: number | null) {
  if (!totalSeconds || totalSeconds <= 0) return '0:00';
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function getStatusDisplay(
  connectionStatus: 'connected' | 'connecting' | 'disconnected',
  modelName: string,
) {
  if (connectionStatus === 'connecting') {
    return { statusColor: 'var(--color-status-connecting)', statusText: 'Connecting...' };
  }
  if (connectionStatus === 'disconnected') {
    return { statusColor: 'var(--color-status-disconnected)', statusText: 'Disconnected' };
  }
  return { statusColor: 'var(--color-status-connected)', statusText: modelName };
}

export function StatusBar({
  connectionStatus,
  modelName = 'BC125AT',
  shellStatusText,
  currentTab,
  sessionStats,
}: StatusBarProps) {
  const { statusColor, statusText } = getStatusDisplay(connectionStatus, modelName);

  return (
    // No role="status" here: this bar holds the live session stats (Hits /
    // Active) that tick continuously, and a status region would announce that
    // churn as noise. Connection transitions are announced by ScanAnnouncer
    // instead (a11y S4).
    <div className="flex items-center justify-between px-4 py-1.5 relative shrink-0 w-full border-t border-scanner-bg-dark bg-scanner-bg-dark/40">
      <div className="flex gap-2 items-center">
        <div className="relative shrink-0 size-[var(--size-status-dot)]">
          <svg className="block size-full" fill="none" preserveAspectRatio="none" viewBox="0 0 8 8">
            <circle cx="4" cy="4" fill={statusColor} r="4" />
          </svg>
        </div>
        <p className="font-sans font-normal scanner-text-light text-xs text-nowrap">{statusText}</p>
        <p className="font-sans font-normal text-white/60 text-xs text-nowrap pl-2">{currentTab}</p>
      </div>
      <div className="flex gap-4 items-center justify-end">
        {sessionStats ? (
          <div className="flex gap-3 items-center text-nowrap">
            <span className="font-sans text-xs text-white/60">
              Hits{' '}
              <span className="font-mono font-medium text-white/80">
                {sessionStats.total_hits ?? 0}
              </span>
            </span>
            <span className="font-sans text-xs text-white/60">
              Active{' '}
              <span className="font-mono font-medium text-white/80">
                {formatActiveDuration(sessionStats.active_time_seconds)}
              </span>
            </span>
            <span className="font-sans text-xs text-white/60">
              Channels{' '}
              <span className="font-mono font-medium text-white/80">
                {sessionStats.unique_channels ?? 0}
              </span>
            </span>
          </div>
        ) : null}
        {shellStatusText ? (
          <p className="font-sans text-[length:var(--size-shell-status-text)] font-normal text-nowrap text-white/60">
            {shellStatusText}
          </p>
        ) : null}
      </div>
    </div>
  );
}

// --- Display: control mini-buttons (top-right of the orange panel) ---

interface ScannerControlsProps {
  volume: number;
  onVolumeChange: (volume: number) => void;
  isHolding: boolean;
  onHoldToggle: () => void;
  onLockout: (type: 'temporary' | 'permanent') => void;
}

const CONTROL_BUTTON_CLASSES =
  'inline-flex items-center justify-center rounded-scanner-xs border border-[rgba(28,31,38,0.8)] px-[clamp(4px,3cqmin,32px)] py-[clamp(2px,1cqmin,16px)] font-mono font-medium text-[clamp(9px,4.5cqmin,52px)] leading-none text-[rgba(28,31,38,0.9)] transition-colors hover:bg-[rgba(28,31,38,0.1)] active:translate-y-[1px]';

function ScannerControls({
  volume,
  onVolumeChange,
  isHolding,
  onHoldToggle,
  onLockout,
}: ScannerControlsProps) {
  return (
    <div className="flex shrink-0 items-center gap-[clamp(4px,2cqmin,28px)]">
      <Popover>
        <PopoverTrigger asChild>
          <button className={CONTROL_BUTTON_CLASSES} aria-label={`Volume ${volume}`}>
            VOL {volume}
          </button>
        </PopoverTrigger>
        <PopoverContent className="scanner-select-content w-40 p-4" side="bottom" align="center">
          <span className="sr-only">Volume {volume}</span>
          <Slider
            defaultValue={[volume]}
            max={15}
            step={1}
            onValueChange={(vals) => onVolumeChange(vals[0])}
          />
        </PopoverContent>
      </Popover>
      <button
        type="button"
        className={CONTROL_BUTTON_CLASSES}
        aria-label="Lockout — click for temporary, double-click for permanent"
        onClick={(e) => {
          if (e.detail === 2) {
            onLockout('permanent');
          } else {
            onLockout('temporary');
          }
        }}
      >
        L/O
      </button>
      <button
        type="button"
        className={cn(
          CONTROL_BUTTON_CLASSES,
          isHolding && 'bg-[rgba(28,31,38,0.8)] text-brand-primary',
        )}
        aria-pressed={isHolding}
        aria-label={isHolding ? 'Resume scan' : 'Hold scanner'}
        onClick={onHoldToggle}
      >
        HOLD
      </button>
    </div>
  );
}

// --- Display: signal bars (dark on amber) ---

function DisplaySignalBars({ strength }: { strength: number }) {
  return (
    <div className="flex shrink-0 items-end gap-[clamp(1px,1cqmin,12px)]">
      {[1, 2, 3, 4, 5].map((bar) => (
        <span
          key={bar}
          className={cn(
            'h-[clamp(8px,7cqmin,128px)] w-[clamp(2px,2cqmin,32px)] rounded-scanner-xs',
            bar <= strength ? 'bg-[rgba(28,31,38,0.8)]' : 'bg-[rgba(28,31,38,0.2)]',
          )}
        />
      ))}
    </div>
  );
}

// --- Display: error icons ---

function UsbErrorIcon() {
  return (
    <div className="relative shrink-0 size-4">
      <svg className="block size-full" fill="none" viewBox="0 0 16 16">
        <path d={usbSvgPaths.p26c64136} fill="rgba(28,31,38,0.9)" />
      </svg>
    </div>
  );
}

function SocketErrorIcon() {
  return (
    <div className="relative shrink-0 size-4">
      <svg className="block size-full" fill="none" viewBox="0 0 16 16">
        <path d={socketSvgPaths.p530b80} fill="rgba(28,31,38,0.9)" />
      </svg>
    </div>
  );
}

// --- Main Display ---

export interface ScannerDisplayProps {
  mainText: string;
  subText?: string;
  signalStrength: number;
  isScanning?: boolean;
  isError?: boolean;
  errorType?: 'usb' | 'socket';
  volume: number;
  isHolding: boolean;
  onVolumeChange: (volume: number) => void;
  onHoldToggle: () => void;
  onLockout: (type: 'temporary' | 'permanent') => void;
  banks: boolean[];
  onBankToggle: (index: number) => void;
  className?: string;
}

/**
 * Orange amber-gradient scanner display panel — the focal point of the
 * Scan view. Wraps the USB indicator, the VOL/LO/HOLD mini-button cluster,
 * the alpha-tag + frequency metadata, and the 10-bank row in a single
 * radial-gradient panel with an inset shadow. Per the Figma redesign
 * (node 89:6), all the previously-separate Scan controls live inside this
 * panel; there's no longer a `monitor` variant.
 */
export function ScannerDisplay({
  mainText,
  subText,
  signalStrength,
  isScanning,
  isError,
  errorType,
  volume,
  isHolding,
  onVolumeChange,
  onHoldToggle,
  onLockout,
  banks,
  onBankToggle,
  className,
}: ScannerDisplayProps) {
  return (
    <div
      className={cn(
        'relative h-full w-full overflow-hidden rounded-scanner-display',
        'bg-[radial-gradient(ellipse_at_50%_30%,#ef991f_0%,#e48813_50%,#d97706_100%)]',
        'shadow-[inset_4px_4px_4px_0px_var(--border-inset)]',
        // container-type: size makes every cqmin/cqi/cqh unit below resolve
        // relative to this panel's box. Combined with the panel being sized
        // 50%×50% inside ScanView, internal type/buttons/signal bars/banks
        // scale fluidly as the window grows or shrinks.
        '[container-type:size]',
        className,
      )}
    >
      <div className="relative flex h-full w-full flex-col gap-[clamp(4px,2.5cqmin,40px)] px-[clamp(8px,4cqmin,64px)] py-[clamp(6px,3.5cqmin,56px)]">
        {/* Top row — USB / error indicator on the left, mini controls on the right */}
        <div className="flex w-full items-center justify-between">
          <div className="relative shrink-0 size-[clamp(12px,5cqmin,80px)] text-[rgba(28,31,38,0.9)]">
            {isError ? (
              errorType === 'socket' ? (
                <SocketErrorIcon />
              ) : (
                <UsbErrorIcon />
              )
            ) : (
              <Usb className="size-full -rotate-45" aria-label="Scanner connected" />
            )}
          </div>
          <ScannerControls
            volume={volume}
            onVolumeChange={onVolumeChange}
            isHolding={isHolding}
            onHoldToggle={onHoldToggle}
            onLockout={onLockout}
          />
        </div>

        {/* Middle — alpha tag (big) + frequency line + signal bars.
            justify-center keeps the metadata vertically centred when the
            display grows past its minimum height (full-screen). Font
            sizes use cqmin so they scale with the panel's smaller side;
            ceilings are sized for 4K kiosk readability rather than a
            desktop window. */}
        <div className="flex flex-1 min-h-0 flex-col justify-center gap-[clamp(4px,2.5cqmin,40px)] border-y border-[rgba(28,31,38,0.6)] py-[clamp(4px,3cqmin,48px)]">
          <FitText
            className={cn(
              'font-display font-extrabold text-[clamp(28px,22cqmin,360px)] leading-[1.2] tracking-tight text-[rgba(28,31,39,0.7)] py-[0.05em]',
              isScanning && 'animate-pulse',
            )}
            title={isScanning ? undefined : mainText}
            minFontSize={16}
          >
            {isScanning ? 'Scanning...' : mainText}
          </FitText>
          <div className="flex w-full items-center justify-between gap-[clamp(8px,2.5cqmin,40px)]">
            <p className="font-mono font-normal text-[clamp(12px,9cqmin,160px)] leading-tight text-[rgba(28,31,39,0.6)] truncate">
              {isScanning ? 'Searching for signal...' : subText || '—'}
            </p>
            {!isScanning && !isError && <DisplaySignalBars strength={signalStrength} />}
          </div>
        </div>

        {/* Bottom — bank row */}
        <BankControls activeBanks={banks} onToggleBank={onBankToggle} />
      </div>
    </div>
  );
}

// --- Bank Controls ---

interface BankControlsProps {
  activeBanks: boolean[]; // Array of 10 booleans
  onToggleBank: (index: number) => void;
}

/**
 * Ten bank buttons (labelled 1–9, 0) embedded at the bottom of the
 * `ScannerDisplay`. The two states mirror the VOL / L-O / HOLD mini
 * cluster up top so the whole panel speaks one visual language:
 *
 * - **Enabled** (currently scanning that bank): filled dark + amber
 *   number — same treatment HOLD picks up when `isHolding` is true.
 * - **Disabled** (skip this bank): outlined dark stroke + dark
 *   number — same treatment the VOL / L-O / HOLD buttons wear in
 *   their resting state (see `CONTROL_BUTTON_CLASSES` above).
 */
export function BankControls({ activeBanks, onToggleBank }: BankControlsProps) {
  const banks = Array.from({ length: 10 }, (_, i) => i + 1);

  return (
    <div className="flex w-full items-center justify-between gap-[clamp(2px,1.2cqmin,18px)]">
      {banks.map((bank, index) => {
        const isActive = activeBanks[index];
        const label = bank === 10 ? '0' : bank.toString();
        return (
          <button
            key={bank}
            type="button"
            onClick={() => onToggleBank(index)}
            aria-pressed={isActive}
            aria-label={`Bank ${label} ${isActive ? '(enabled)' : '(disabled)'}`}
            className={cn(
              'inline-flex h-[clamp(18px,9cqmin,120px)] flex-1 items-center justify-center rounded-scanner-xs font-mono font-medium text-[clamp(11px,6cqmin,80px)] leading-none transition-colors active:translate-y-[1px]',
              isActive
                ? 'bg-[rgba(28,31,38,0.7)] text-brand-primary hover:bg-[rgba(28,31,38,0.85)]'
                : 'border border-[rgba(28,31,38,0.8)] text-[rgba(28,31,38,0.9)] hover:bg-[rgba(28,31,38,0.1)]',
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
