import { useCallback } from "react";
import { motion } from "motion/react";
import { Radio, X } from "lucide-react";

import { cn } from "../../../lib/utils";
import { useAPI } from "../../../api/useApi";

export function SearchTab() {
  const api = useAPI();

  const handleSelect = useCallback(async (mode: "service" | "custom") => {
    if (mode === "service") {
      // Enable Service Search - scan predefined bands
      // TODO: Implement Service Search API
      console.log("Service Search selected");
    } else if (mode === "custom") {
      // Enable Custom Search - scan user-defined ranges
      // TODO: Implement Custom Search API
      console.log("Custom Search selected");
    }
  }, [api]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex h-full items-center justify-center"
    >
      <div className="bg-black/40 rounded-lg border border-white/10 p-12 text-center max-w-lg">
        <h2 className="text-lg font-bold text-white mb-2">Search Mode</h2>
        <p className="text-sm text-white/60 mb-8">
          Choose how you want to search:
        </p>

        <div className="grid grid-cols-2 gap-4">
          <button
            onClick={() => handleSelect("service")}
            className={cn(
              "flex flex-col items-center gap-4 p-6 rounded-lg border transition-all",
              "bg-white/5 border-white/10 hover:bg-white/10 hover:border-white/20"
            )}
          >
            <div className="p-3 rounded bg-brand-primary/20 text-brand-primary border border-brand-primary/30">
              <Radio size={24} />
            </div>
            <div className="text-left">
              <h3 className="font-bold text-white text-base mb-1">Service Search</h3>
              <p className="text-sm text-white/60">
                Scan predefined service bands like Police, Fire, EMS, etc.
              </p>
            </div>
          </button>

          <button
            onClick={() => handleSelect("custom")}
            className={cn(
              "flex flex-col items-center gap-4 p-6 rounded-lg border transition-all",
              "bg-white/5 border-white/10 hover:bg-white/10 hover:border-white/20"
            )}
          >
            <div className="p-3 rounded bg-brand-primary/20 text-brand-primary border border-brand-primary/30">
              <Radio size={24} />
            </div>
            <div className="text-left">
              <h3 className="font-bold text-white text-base mb-1">Custom Search</h3>
              <p className="text-sm text-white/60">
                Search up to 10 custom frequency ranges
              </p>
            </div>
          </button>
        </div>
      </div>
    </motion.div>
  );
}
