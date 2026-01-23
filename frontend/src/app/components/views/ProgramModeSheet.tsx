import { RefreshCcw } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import { Button } from "../ui/button";
import { cn } from "../../../lib/utils";

interface ProgramModeSheetProps {
  isOpen: boolean;
  onClose: () => void;
  isSyncing: boolean;
  onEnterProgramMode: () => void;
}

export function ProgramModeSheet({
  isOpen,
  onClose,
  isSyncing,
  onEnterProgramMode,
}: ProgramModeSheetProps) {
  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="bottom" className="sm:max-w-lg mx-auto">
        <SheetHeader>
          <SheetTitle>Enter Program Mode</SheetTitle>
          <SheetDescription>
            Device configuration requires the scanner to be in program mode.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 py-4">
          <div className="flex items-start gap-3 p-4 bg-white/5 rounded-lg border border-white/10">
            <div className="p-2 rounded bg-brand-primary/10 text-brand-primary border border-brand-primary/20">
              <RefreshCcw className={cn("w-4 h-4", isSyncing && "animate-spin")} />
            </div>
            <div className="flex-1 space-y-2">
              <h3 className="font-bold text-white text-sm">About Program Mode</h3>
              <p className="text-xs text-white/60 leading-relaxed">
                When you enter program mode, the scanner switches configuration mode and
                scanning pauses. This is required for reading and writing device settings,
                channels, and other configuration data.
              </p>
            </div>
          </div>

          <div className="text-sm text-white/60 leading-relaxed">
            <p>
              After entering program mode, you will be able to access the Device or Channels
              configuration pages.
            </p>
          </div>
        </div>

        <SheetFooter>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={isSyncing}
            className="bg-white/10 border-white/20 text-white hover:bg-white/20"
          >
            Cancel
          </Button>
          <Button
            onClick={onEnterProgramMode}
            disabled={isSyncing}
            className="bg-brand-primary hover:bg-brand-hover text-black font-bold shadow-brand hover:shadow-brand-lg"
          >
            <RefreshCcw className={cn("w-4 h-4 mr-2", isSyncing && "animate-spin")} />
            {isSyncing ? "Entering Program Mode..." : "Enter Program Mode"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
