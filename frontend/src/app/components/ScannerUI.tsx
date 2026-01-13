import React from "react";
import { cn } from "../../lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Slider } from "./ui/slider";
import svgPaths from "../../imports/svg-govmzsdb93";
import usbSvgPaths from "../../imports/svg-4af8p5er03";
import socketSvgPaths from "../../imports/svg-10gl6kikm0";

// --- Tab Navigation ---

interface TabNavProps {
  currentTab: string;
  onTabChange: (tab: string) => void;
}

export function TabNav({ currentTab, onTabChange }: TabNavProps) {
  const tabs = ["Scan", "Device", "Channels"];

  return (
    <div className="flex gap-[16px] items-start pb-px pt-0 px-0 relative shrink-0 w-full border-b border-[#1c1f26]">
      {tabs.map((tab) => {
        const isActive = currentTab === tab;
        return (
          <button
            key={tab}
            onClick={() => onTabChange(tab)}
            className={cn(
              "flex flex-col items-center justify-center px-[12px] py-[4px] relative shrink-0 transition-colors focus:outline-none",
              isActive ? "text-white" : "text-[#f5ebe8] hover:text-white"
            )}
          >
            {isActive && (
              <div
                aria-hidden="true"
                className="absolute border-b-[2px] border-[#d97706]/50 inset-0 pointer-events-none"
              />
            )}
            <p
              className={cn(
                "text-[12px] text-nowrap",
                isActive ? "font-bold" : "font-semibold"
              )}
            >
              {tab}
            </p>
          </button>
        );
      })}
    </div>
  );
}

// --- Header / Status ---

interface StatusHeaderProps {
  connectionStatus: "connected" | "connecting" | "disconnected";
  modelName?: string;
  volume: number;
  onVolumeChange: (volume: number) => void;
  isHolding: boolean;
  onHoldToggle: () => void;
  onLockout: (type: "temporary" | "permanent") => void;
  isRecording?: boolean;
  onRecordingToggle?: () => void;
}

export function StatusHeader({
  connectionStatus,
  modelName = "BC125AT",
  volume,
  onVolumeChange,
  isHolding,
  onHoldToggle,
  onLockout,
  isRecording = false,
  onRecordingToggle,
}: StatusHeaderProps) {
  let statusColor = "#67E79E"; // Connected (Green)
  let statusText = modelName;

  if (connectionStatus === "connecting") {
    statusColor = "#F59E0B"; // Amber
    statusText = "Connecting...";
  } else if (connectionStatus === "disconnected") {
    statusColor = "#DC3A38"; // Red
    statusText = "Disconnected";
  }

  return (
    <div className="flex items-center justify-between relative shrink-0 w-full">
      {/* Status LED & Text */}
      <div className="flex gap-[8px] items-center relative shrink-0">
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
        <p className="font-sans font-normal text-[#f5ebe8] text-[10px] text-nowrap">
          {statusText}
        </p>
      </div>

      {/* Buttons: REC, VOL, L/O, HOLD */}
      <div className="flex gap-[10px] items-center relative shrink-0">
        <button
          onClick={onRecordingToggle}
          className={cn(
            "flex items-center justify-center px-[6px] py-[2px] rounded-[2px] shadow-[1px_1px_0px_0px_rgba(0,0,0,0.25)] shrink-0 cursor-pointer transition-all active:translate-y-[1px] active:shadow-none gap-1.5",
            isRecording ? "bg-red-500/20 border border-red-500/50" : "bg-[#4c627d] hover:bg-[#5a738e]"
          )}
        >
           <div className={cn("size-1.5 rounded-full", isRecording ? "bg-red-500 animate-pulse shadow-[0_0_5px_rgba(239,68,68,0.8)]" : "bg-[#acbbcc]")} />
           <p className={cn("font-medium text-[10px] text-nowrap", isRecording ? "text-red-400" : "text-[#acbbcc]")}>
             REC
           </p>
        </button>

        <Popover>
          <PopoverTrigger asChild>
            <button className="bg-[#4c627d] hover:bg-[#5a738e] active:translate-y-[1px] active:shadow-none transition-all flex items-center justify-center px-[4px] py-[2px] rounded-[2px] shadow-[1px_1px_0px_0px_rgba(0,0,0,0.25)] shrink-0 cursor-pointer">
              <p className="font-medium text-[#acbbcc] text-[10px] text-nowrap">
                VOL {volume}
              </p>
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-40 bg-[#1c1f26] border border-white/10 p-4" side="bottom" align="center">
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
             // Simple click logic handled by parent usually, but here we can demo
             // Double click logic is complex in simple buttons, letting parent handle via simple click for now
             // Or we can use onClick/onDoubleClick
             if (e.detail === 2) {
                 onLockout("permanent");
             } else {
                 onLockout("temporary");
             }
          }}
          className="bg-[#4c627d] hover:bg-[#5a738e] active:translate-y-[1px] active:shadow-none transition-all flex items-center justify-center px-[4px] py-[2px] rounded-[2px] shadow-[1px_1px_0px_0px_rgba(0,0,0,0.25)] shrink-0 cursor-pointer"
        >
          <p className="font-medium text-[#acbbcc] text-[10px] text-nowrap">
            L/O
          </p>
        </button>
        <button
          onClick={onHoldToggle}
          className={cn(
            "flex items-center justify-center px-[4px] py-[2px] rounded-[2px] shrink-0 cursor-pointer transition-all active:translate-y-[1px] active:shadow-none border",
            isHolding 
              ? "bg-[rgba(43,48,59,0.5)] border-[#ef991f]" 
              : "bg-[#4c627d] hover:bg-[#5a738e] border-transparent shadow-[1px_1px_0px_0px_rgba(0,0,0,0.25)]"
          )}
        >
          <p className={cn("font-medium text-[10px] text-nowrap", isHolding ? "text-[#ef991f]" : "text-[#acbbcc]")}>
            HOLD
          </p>
        </button>
      </div>
    </div>
  );
}

// --- Icons ---

function SignalIcon({ strength }: { strength: number }) {
  // strength 0-5
  // Original SVG has multiple paths. We can just show the full icon for now or adapt it.
  // The original component draws separate paths for bars.
  // p3025b700 is the antenna/mast
  // p31141000 is bar 1?
  // p30ee9a00 is bar 2?
  // etc.
  // For simplicity and fidelity, I'll render the static icon from Figma or try to make it dynamic if I can map the paths.
  // Let's just use the full icon as "Signal Present" indicator for now, as splitting it might be tricky without trial and error.
  
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
          {/* p45ef080 seems to be the base or another part */}
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
        "flex flex-col gap-[8px] items-start px-[12px] py-[10px] relative w-full h-full",
        variant === "hero" ? "justify-between py-8 px-8" : "justify-center"
      )}>
        {/* Main Row */}
        <div className={cn(
          "flex items-center justify-between w-full relative pb-[4px]",
          variant === "hero" ? "border-none flex-1 items-center" : "border-b border-[rgba(43,48,59,0.7)]"
        )}>
          <p className={cn(
            "font-bold text-[rgba(28,31,39,0.9)] text-nowrap truncate max-w-[90%] transition-all duration-500",
            variant === "hero" ? "text-[80px] leading-tight tracking-tight" : "text-[40px]"
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
          "flex gap-[8px] items-start w-full relative transition-all duration-500",
          variant === "hero" ? "border-t border-[rgba(43,48,59,0.3)] pt-4" : ""
        )}>
          <p className={cn(
            "font-normal text-[rgba(28,31,39,0.9)] text-nowrap transition-all duration-500",
            variant === "hero" ? "text-[24px] opacity-90 font-medium" : "text-[20px]"
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
      <div className="absolute inset-[-1px] pointer-events-none shadow-[inset_4px_4px_4px_0px_#b06105]" />
      <div
        aria-hidden="true"
        className="absolute border border-[#1e2024] inset-[-1px] pointer-events-none rounded-[7px]"
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
    <div className="flex gap-[1px] w-full justify-between">
      {banks.map((bank, index) => {
        const isActive = activeBanks[index];
        const label = bank === 10 ? "0" : bank.toString();
        // Index is 0-9
        return (
          <button
            key={bank}
            onClick={() => onToggleBank(index)}
            className={cn(
              "flex items-center justify-center h-[24px] flex-1 min-w-0 mx-[2px] rounded-[2px] relative transition-all border",
              isActive
                ? "bg-[rgba(43,48,59,0.5)] border-[#ef991f]"
                : "bg-[#4c627d] border-transparent shadow-[1px_1px_0px_0px_rgba(0,0,0,0.25)]"
            )}
          >
            <p
              className={cn(
                "font-medium text-[10px]",
                isActive ? "text-[#ef991f]" : "text-[#acbbcc]"
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
