import React from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { cn } from "../../lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Slider } from "./ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import svgPaths from "../../imports/svg-govmzsdb93";
import usbSvgPaths from "../../imports/svg-4af8p5er03";
import socketSvgPaths from "../../imports/svg-10gl6kikm0";

// --- Tab Navigation ---

interface TabNavProps {
  currentTab: string;
  onTabChange: (tab: string) => void;
  connectionStatus: "connected" | "connecting" | "disconnected";
  modelName?: string;
  shellStatusText?: string | null;
}

function getStatusDisplay(
  connectionStatus: "connected" | "connecting" | "disconnected",
  modelName: string,
) {
  if (connectionStatus === "connecting") {
    return { statusColor: "#F59E0B", statusText: "Connecting..." };
  }
  if (connectionStatus === "disconnected") {
    return { statusColor: "#DC3A38", statusText: "Disconnected" };
  }
  return { statusColor: "#67E79E", statusText: modelName };
}

export function TabNav({
  currentTab,
  onTabChange,
  connectionStatus,
  modelName = "BC125AT",
  shellStatusText,
}: TabNavProps) {
  const tabs = ["Scan", "Device", "Channels"];
  const { statusColor, statusText } = getStatusDisplay(
    connectionStatus,
    modelName,
  );

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
                "flex flex-col items-center justify-center px-3 py-1 relative transition-colors focus:outline-none",
                isActive ? "text-white" : "scanner-text-light hover:text-white"
              )}
            >
              {isActive && (
                <div
                  aria-hidden="true"
                  className="absolute border-b-2 border-brand-hover/50 inset-0 pointer-events-none"
                />
              )}
              <p
                className={cn(
                  "text-sm text-nowrap",
                  isActive ? "font-bold" : "font-semibold"
                )}
              >
                {tab}
              </p>
            </button>
          );
        })}
      </div>
      <div className="flex gap-2 items-center justify-end">
        {shellStatusText ? (
          <p className="font-sans font-normal text-[10px] text-white/40 text-nowrap mr-2">
            {shellStatusText}
          </p>
        ) : null}
        <div className="relative shrink-0 size-[8px]">
          <svg
            className="block size-full"
            fill="none"
            preserveAspectRatio="none"
            viewBox="0 0 8 8"
          >
            <circle cx="4" cy="4" fill={statusColor} r="4" />
          </svg>
        </div>
        <p className="font-sans font-normal scanner-text-light text-xs text-nowrap">
          {statusText}
        </p>
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
  onLockout: (type: "temporary" | "permanent") => void;
  isRecording?: boolean;
  onRecordingToggle?: () => void;
  isDashboardMode: boolean;
  onDashboardToggle: () => void;
}

export function StatusHeader({
  volume,
  onVolumeChange,
  isHolding,
  onHoldToggle,
  onLockout,
  isRecording = false,
  onRecordingToggle,
  isDashboardMode,
  onDashboardToggle,
}: StatusHeaderProps) {
  return (
    <div className="flex items-center justify-between relative shrink-0 w-full">
      {/* Dashboard + Recording controls */}
      <div className="flex gap-2.5 items-center relative shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onDashboardToggle}
              className="bg-scanner-default hover:bg-scanner-hover active:translate-y-[1px] active:shadow-none transition-all flex items-center justify-center px-1 py-0.5 rounded-scanner-sm border border-scanner-border shadow-button shrink-0 cursor-pointer"
              aria-pressed={isDashboardMode}
              aria-label={isDashboardMode ? "Switch to monitor view" : "Switch to dashboard view"}
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
            className="bg-neutral-950 border border-white/10 text-white"
            arrowClassName="bg-neutral-950 fill-neutral-950"
          >
            {isDashboardMode ? "Dashboard view" : "Monitor view"}
          </TooltipContent>
        </Tooltip>
        <button
          onClick={onRecordingToggle}
          className={cn(
            "flex items-center justify-center px-1.5 py-0.5 rounded-scanner-sm border border-scanner-border shadow-button shrink-0 cursor-pointer transition-all active:translate-y-[1px] active:shadow-none gap-1.5",
            isRecording ? "bg-red-500/20 border-red-500/50" : "bg-scanner-default hover:bg-scanner-hover"
          )}
        >
           <div className={cn("size-1.5 rounded-full", isRecording ? "bg-red-500 animate-pulse shadow-glow" : "bg-scanner-text")} />
           <p className={cn("font-medium text-xs text-nowrap", isRecording ? "text-red-400" : "scanner-text")}>
             REC
           </p>
        </button>
      </div>

      {/* Native scanner controls */}
      <div className="flex gap-2.5 items-center relative shrink-0">
        <Popover>
          <PopoverTrigger asChild>
            <button className="bg-scanner-default hover:bg-scanner-hover active:translate-y-[1px] active:shadow-none transition-all flex items-center justify-center px-1 py-0.5 rounded-scanner-sm border border-scanner-border shadow-button shrink-0 cursor-pointer">
              <p className="font-medium scanner-text text-xs text-nowrap">
                VOL {volume}
              </p>
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-40 bg-neutral-950 border border-white/10 p-4" side="bottom" align="center">
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
                 onLockout("permanent");
             } else {
                 onLockout("temporary");
             }
          }}
          className="bg-scanner-default hover:bg-scanner-hover active:translate-y-[1px] active:shadow-none transition-all flex items-center justify-center px-1 py-0.5 rounded-scanner-sm border border-scanner-border shadow-button shrink-0 cursor-pointer"
        >
          <p className="font-medium scanner-text text-xs text-nowrap">
            L/O
          </p>
        </button>
        <button
          onClick={onHoldToggle}
          className={cn(
            "flex items-center justify-center px-1 py-0.5 rounded-scanner-sm shrink-0 cursor-pointer transition-all active:translate-y-[1px] active:shadow-none border",
            isHolding 
              ? "bg-scanner-bg-semiDark border-brand-primary" 
              : "bg-scanner-default hover:bg-scanner-hover border-scanner-border shadow-button"
          )}
        >
          <p className={cn("font-medium text-xs text-nowrap", isHolding ? "text-brand-primary" : "scanner-text")}>
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
          <path d={svgPaths.p3025b700} fill="var(--fill-0, #1C1F27)" fillOpacity="0.9" />
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
        <path d={usbSvgPaths.p26c64136} fill="var(--fill-0, #1C1F27)" fillOpacity="0.9" />
      </svg>
    </div>
  );
}

function SocketErrorIcon() {
  return (
    <div className="relative shrink-0 size-[16px]">
      <svg className="block size-full" fill="none" viewBox="0 0 16 16">
        <path d={socketSvgPaths.p530b80} fill="var(--fill-0, #1C1F27)" fillOpacity="0.9" />
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
  errorType?: "usb" | "socket";
  isScanning?: boolean;
  className?: string;
  variant?: "default" | "hero";
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
  variant = "default",
}: ScannerDisplayProps) {
  // Gradient background from Figma
  const bgStyle = {
    backgroundImage:
      "url('data:image/svg+xml;utf8,<svg viewBox=\\\'0 0 291 81\\\' xmlns=\\\'http://www.w3.org/2000/svg\\\' preserveAspectRatio=\\\'none\\\'><rect x=\\\'0\\\' y=\\\'0\\\' height=\\\'100%\\\' width=\\\'100%\\\' fill=\\\'url(%23grad)\\\' opacity=\\\'1\\\'/><defs><radialGradient id=\\\'grad\\\' gradientUnits=\\\'userSpaceOnUse\\\' cx=\\\'0\\\' cy=\\\'0\\\' r=\\\'10\\\' gradientTransform=\\\'matrix(14.55 0 0 4.05 145.5 40.5)\\\'><stop stop-color=\\\'rgba(239,153,31,1)\\\' offset=\\\'0\\\'/><stop stop-color=\\\'rgba(228,136,19,1)\\\' offset=\\\'0.5\\\'/><stop stop-color=\\\'rgba(217,119,6,1)\\\' offset=\\\'1\\\'/></radialGradient></defs></svg>')",
  };

  return (
    <div
      className={cn(
        "relative rounded-[6px] shrink-0 w-full overflow-hidden transition-all duration-500 ease-in-out",
        !className?.includes("h-") && (variant === "hero" ? "h-full min-h-[200px]" : "h-[81px]"),
        className
      )}
      style={bgStyle}
    >
      <div className={cn(
        "flex flex-col gap-2 items-start px-3 py-2.5 relative w-full h-full",
        variant === "hero" ? "justify-between py-8 px-8" : "justify-center"
      )}>
        {/* Main Row */}
        <div className={cn(
          "flex items-center justify-between w-full relative pb-[4px]",
          variant === "hero" ? "border-none flex-1 items-center" : "border-b border-[rgba(43,48,59,0.7)]"
        )}>
          <p className={cn(
            "font-bold text-[rgba(28,31,39,0.9)] text-nowrap truncate max-w-[90%] transition-all duration-500",
            variant === "hero" ? "text-4xl leading-tight tracking-tight" : "text-3xl"
          )}>
            {isScanning ? (
              <span className="animate-pulse">Scanning...</span>
            ) : (
              mainText
            )}
          </p>
          <div className={cn(
            "shrink-0 transition-all duration-500",
            variant === "hero" ? "size-[64px] opacity-80" : "size-[16px]"
          )}>
            {isError ? (
              errorType === "usb" ? <UsbErrorIcon /> : <SocketErrorIcon />
            ) : null}
          </div>
        </div>

        {/* Sub Row */}
        <div className={cn(
          "flex gap-2 items-start w-full relative transition-all duration-500",
          variant === "hero" ? "border-t border-[rgba(43,48,59,0.3)] pt-4" : ""
        )}>
          <p className={cn(
            "font-normal text-[rgba(28,31,39,0.9)] transition-all duration-500",
            isError ? "whitespace-normal leading-snug" : "text-nowrap",
            variant === "hero" ? "text-xl opacity-90 font-medium" : "text-lg"
          )}>
            {isScanning ? (
              <span className="opacity-50">Searching for signal...</span>
            ) : (
              subText || "—"
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
        const label = bank === 10 ? "0" : bank.toString();
        // Index is 0-9
        return (
          <button
            key={bank}
            onClick={() => onToggleBank(index)}
             className={cn(
               "flex items-center justify-center h-[24px] flex-1 min-w-0 mx-[2px] rounded-scanner-sm relative transition-all border",
               isActive
                 ? "bg-scanner-bg-semiDark border-brand-primary"
                 : "bg-scanner-default border-scanner-border shadow-button"
             )}
          >
            <p
              className={cn(
                "font-medium text-xs",
                isActive ? "text-brand-primary" : "scanner-text"
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
