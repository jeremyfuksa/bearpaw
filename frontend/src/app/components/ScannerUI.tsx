import React from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Slider } from './ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import svgPaths from '../../imports/svg-govmzsdb93';
import usbSvgPaths from '../../imports/svg-4af8p5er03';
import socketSvgPaths from '../../imports/svg-10gl6kikm0';

// --- Tab Navigation ---

interface TabNavProps {
  currentTab: string;
  onTabChange: (tab: string) => void;
  connectionStatus: 'connected' | 'connecting' | 'disconnected';
  modelName?: string;
  shellStatusText?: string | null;
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

export function TabNav({
  currentTab,
  onTabChange,
  connectionStatus,
  modelName = 'BC125AT',
  shellStatusText,
}: TabNavProps) {
  const tabs = ['Scan', 'Device', 'Channels'];
  const { statusColor, statusText } = getStatusDisplay(connectionStatus, modelName);

  return (
    <div className="flex items-center justify-between pb-px pt-0 px-0 relative shrink-0 w-full border-b border-scanner-bg-dark">
      <div className="flex gap-4 items-start">
        {tabs.map((tab) => {
          const isActive = currentTab === tab;
          return (
            <button
              key={tab}
              onClick={() => onTabChange(tab)}
              className={cn(
                'flex flex-col items-center justify-center px-3 py-1 relative transition-colors focus:outline-none',
                isActive ? 'text-white' : 'scanner-text-light hover:text-white',
              )}
            >
              {isActive && (
                <div
                  aria-hidden="true"
                  className="absolute border-b-2 border-brand-hover/50 inset-0 pointer-events-none"
                />
              )}
              <p className={cn('text-sm text-nowrap', isActive ? 'font-bold' : 'font-semibold')}>
                {tab}
              </p>
            </button>
          );
        })}
      </div>
      <div className="flex gap-2 items-center justify-end">
        {shellStatusText ? (
          <p className="mr-2 font-sans text-[length:var(--size-shell-status-text)] font-normal text-nowrap text-white/40">
            {shellStatusText}
          </p>
        ) : null}
        <div className="relative shrink-0 size-[var(--size-status-dot)]">
          <svg className="block size-full" fill="none" preserveAspectRatio="none" viewBox="0 0 8 8">
            <circle cx="4" cy="4" fill={statusColor} r="4" />
          </svg>
        </div>
        <p className="font-sans font-normal scanner-text-light text-xs text-nowrap">{statusText}</p>
      </div>
    </div>
  );
}

// --- Header / Status ---

interface StatusHeaderProps {
  volume: number;
  onVolumeChange: (volume: number) => void;
  isHolding: boolean;
  onHoldToggle: () => void;
  onLockout: (type: 'temporary' | 'permanent') => void;
  isDashboardMode: boolean;
  onDashboardToggle: () => void;
}

export function StatusHeader({
  volume,
  onVolumeChange,
  isHolding,
  onHoldToggle,
  onLockout,
  isDashboardMode,
  onDashboardToggle,
}: StatusHeaderProps) {
  return (
    <div className="flex items-center justify-between relative shrink-0 w-full">
      {/* Dashboard control */}
      <div className="flex gap-2.5 items-center relative shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onDashboardToggle}
              className="bg-scanner-default hover:bg-scanner-hover active:translate-y-[1px] active:shadow-none transition-all flex items-center justify-center px-1 py-0.5 rounded-scanner-sm border border-scanner-border shadow-button shrink-0 cursor-pointer"
              aria-pressed={isDashboardMode}
              aria-label={isDashboardMode ? 'Switch to monitor view' : 'Switch to dashboard view'}
            >
              {isDashboardMode ? (
                <Minimize2 className="size-3.5" />
              ) : (
                <Maximize2 className="size-3.5" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            align="center"
            className="scanner-select-content"
            arrowClassName="bg-background fill-background"
          >
            {isDashboardMode ? 'Dashboard view' : 'Monitor view'}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Native scanner controls */}
      <div className="flex gap-2.5 items-center relative shrink-0">
        <Popover>
          <PopoverTrigger asChild>
            <button className="bg-scanner-default hover:bg-scanner-hover active:translate-y-[1px] active:shadow-none transition-all flex items-center justify-center px-1 py-0.5 rounded-scanner-sm border border-scanner-border shadow-button shrink-0 cursor-pointer">
              <p className="font-medium scanner-text text-xs text-nowrap">VOL {volume}</p>
            </button>
          </PopoverTrigger>
          <PopoverContent className="scanner-select-content w-40 p-4" side="bottom" align="center">
            <div className="flex flex-col">
              <span className="sr-only">Volume {volume}</span>
              <Slider
                defaultValue={[volume]}
                max={20}
                step={1}
                onValueChange={(vals) => onVolumeChange(vals[0])}
              />
            </div>
          </PopoverContent>
        </Popover>
        <button
          onClick={(e) => {
            if (e.detail === 2) {
              onLockout('permanent');
            } else {
              onLockout('temporary');
            }
          }}
          className="bg-scanner-default hover:bg-scanner-hover active:translate-y-[1px] active:shadow-none transition-all flex items-center justify-center px-1 py-0.5 rounded-scanner-sm border border-scanner-border shadow-button shrink-0 cursor-pointer"
        >
          <p className="font-medium scanner-text text-xs text-nowrap">L/O</p>
        </button>
        <button
          onClick={onHoldToggle}
          className={cn(
            'flex items-center justify-center px-1 py-0.5 rounded-scanner-sm shrink-0 cursor-pointer transition-all active:translate-y-[1px] active:shadow-none border',
            isHolding
              ? 'bg-scanner-bg-semiDark border-brand-primary'
              : 'bg-scanner-default hover:bg-scanner-hover border-scanner-border shadow-button',
          )}
        >
          <p
            className={cn(
              'font-medium text-xs text-nowrap',
              isHolding ? 'text-brand-primary' : 'scanner-text',
            )}
          >
            HOLD
          </p>
        </button>
      </div>
    </div>
  );
}

// --- Icons ---

function SignalIcon({ strength }: { strength: number }) {
  // Render bars progressively (0-5) over the shared base icon.
  return (
    <div className="relative shrink-0 size-[16px]">
      <svg className="block size-full" fill="none" viewBox="0 0 16 14.0694">
        <g id="signal">
          <path d={svgPaths.p3025b700} fill="var(--bg-scanner-dark)" fillOpacity="0.9" />
          {strength > 0 && <path d={svgPaths.p31141000} fill="black" />}
          {strength > 1 && <path d={svgPaths.p30ee9a00} fill="black" />}
          {strength > 2 && <path d={svgPaths.pd4593f0} fill="black" />}
          {strength > 3 && <path d={svgPaths.p24eea280} fill="black" />}
          {strength > 4 && <path d={svgPaths.p1690cd00} fill="black" />}
          <path d={svgPaths.p45ef080} fill="black" />
        </g>
      </svg>
    </div>
  );
}

function UsbErrorIcon() {
  return (
    <div className="relative shrink-0 size-[16px]">
      <svg className="block size-full" fill="none" viewBox="0 0 16 16">
        <path d={usbSvgPaths.p26c64136} fill="var(--bg-scanner-dark)" fillOpacity="0.9" />
      </svg>
    </div>
  );
}

function SocketErrorIcon() {
  return (
    <div className="relative shrink-0 size-[16px]">
      <svg className="block size-full" fill="none" viewBox="0 0 16 16">
        <path d={socketSvgPaths.p530b80} fill="var(--bg-scanner-dark)" fillOpacity="0.9" />
      </svg>
    </div>
  );
}

// --- Main Display ---

interface ScannerDisplayProps {
  mainText: string;
  subText?: string;
  mode: string;
  signalStrength: number;
  isError?: boolean;
  errorType?: 'usb' | 'socket';
  isScanning?: boolean;
  className?: string;
  variant?: 'default' | 'hero' | 'monitor';
}

export function ScannerDisplay({
  mainText,
  subText,
  mode,
  signalStrength,
  isError,
  errorType,
  isScanning,
  className,
  variant = 'default',
}: ScannerDisplayProps) {
  return (
    <div
      className={cn(
        'scanner-display-surface relative shrink-0 w-full overflow-hidden rounded-scanner-md transition-all duration-500 ease-in-out',
        !className?.includes('h-') &&
          (variant === 'hero' || variant === 'monitor'
            ? 'h-full min-h-[var(--size-signal-display-min-height)]'
            : 'h-[var(--size-signal-display-height)]'),
        className,
      )}
    >
      <div
        className={cn(
          'flex flex-col gap-2 items-start px-3 py-2.5 relative w-full h-full',
          variant === 'hero'
            ? 'justify-between px-8 py-8'
            : variant === 'monitor'
              ? 'justify-center px-12 py-10'
              : 'justify-center',
        )}
      >
        {/* Main Row */}
        <div
          className={cn(
            'relative flex w-full items-center justify-between pb-1',
            variant === 'hero' || variant === 'monitor'
              ? 'flex-1 items-center border-none'
              : 'border-b border-scanner-border/70',
          )}
        >
          <p
            className={cn(
              'max-w-full truncate text-nowrap font-bold text-text-display-dark/90 transition-all duration-500',
              variant === 'monitor'
                ? 'text-7xl leading-none tracking-tight'
                : variant === 'hero'
                  ? 'text-4xl leading-tight tracking-tight'
                  : 'text-3xl',
            )}
          >
            {isScanning ? <span className="animate-pulse">Scanning...</span> : mainText}
          </p>
          <div
            className={cn(
              'shrink-0 transition-all duration-500',
              variant === 'monitor'
                ? 'size-20 opacity-80'
                : variant === 'hero'
                  ? 'size-16 opacity-80'
                  : 'size-[var(--size-icon-sm)]',
            )}
          >
            {isError ? errorType === 'usb' ? <UsbErrorIcon /> : <SocketErrorIcon /> : null}
          </div>
        </div>

        {/* Sub Row */}
        <div
          className={cn(
            'flex gap-2 items-start w-full relative transition-all duration-500',
            variant === 'hero' || variant === 'monitor'
              ? 'border-t border-scanner-border/30 pt-4'
              : '',
          )}
        >
          <p
            className={cn(
              'font-normal text-text-display-dark/90 transition-all duration-500',
              isError ? 'whitespace-normal leading-snug' : 'text-nowrap',
              variant === 'monitor'
                ? 'text-3xl font-medium opacity-90'
                : variant === 'hero'
                  ? 'text-xl font-medium opacity-90'
                  : 'text-lg',
            )}
          >
            {isScanning ? (
              <span className="opacity-50">Searching for signal...</span>
            ) : (
              subText || '—'
            )}
          </p>
        </div>
      </div>

      {/* Shadow Overlay */}
      <div className="absolute inset-[-1px] pointer-events-none shadow-inset" />
      <div
        aria-hidden="true"
        className="absolute border border-scanner-border inset-[-1px] pointer-events-none rounded-scanner-display"
      />
    </div>
  );
}

// --- Bank Controls ---

interface BankControlsProps {
  activeBanks: boolean[]; // Array of 10 booleans
  onToggleBank: (index: number) => void;
}

export function BankControls({ activeBanks, onToggleBank }: BankControlsProps) {
  const banks = Array.from({ length: 10 }, (_, i) => i + 1); // 1..10

  return (
    <div className="flex gap-0.25 w-full justify-between">
      {banks.map((bank, index) => {
        const isActive = activeBanks[index];
        const label = bank === 10 ? '0' : bank.toString();
        // Index is 0-9
        return (
          <button
            key={bank}
            onClick={() => onToggleBank(index)}
            className={cn(
              'relative mx-[var(--size-bank-control-spacing)] flex h-[var(--size-bank-control-height)] min-w-0 flex-1 items-center justify-center rounded-scanner-sm border transition-all',
              isActive
                ? 'bg-scanner-bg-semiDark border-brand-primary'
                : 'bg-scanner-default border-scanner-border shadow-button',
            )}
          >
            <p
              className={cn(
                'font-medium text-xs',
                isActive ? 'text-brand-primary' : 'scanner-text',
              )}
            >
              {label}
            </p>
          </button>
        );
      })}
    </div>
  );
}
