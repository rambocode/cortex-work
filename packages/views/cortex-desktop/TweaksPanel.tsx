import { useState } from "react";
import { SegmentedRadio } from "@cortex-work/ui/controls/SegmentedRadio";
import { PaletteChips, type PaletteOption } from "@cortex-work/ui/controls/PaletteChips";
import type { Density, Palette, SidebarMode, Tweaks } from "@cortex-work/core/types";

const PALETTES: PaletteOption[] = [
  { id: "clay", name: "Clay", colors: ["#c96442", "#f3e7df", "#1a1916"] },
  { id: "twilight", name: "Twilight", colors: ["#7c3aed", "#ede5fd", "#1a1916"] },
  { id: "forest", name: "Forest", colors: ["#0d9488", "#d4ebe8", "#1a1916"] },
  { id: "ink", name: "Ink", colors: ["#1a1916", "#e6e4dd", "#5e5c56"] },
];

export interface TweaksPanelProps {
  tweaks: Tweaks;
  onSetTweak: <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void;
}

export function TweaksPanel({ tweaks, onSetTweak }: TweaksPanelProps) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button className="twk-fab" onClick={() => setOpen(true)}>
        Tweaks
      </button>
    );
  }

  return (
    <div className="twk-panel">
      <div className="twk-hd">
        <b>Tweaks</b>
        <button className="twk-x" aria-label="关闭" onClick={() => setOpen(false)}>
          ✕
        </button>
      </div>
      <div className="twk-body">
        <div className="twk-sect">布局密度 · Density</div>
        <SegmentedRadio
          value={tweaks.density}
          options={["compact", "regular", "cozy"]}
          onChange={(v) => onSetTweak("density", v as Density)}
        />

        <div className="twk-sect">品牌色调 · Palette</div>
        <PaletteChips value={tweaks.palette} options={PALETTES} onChange={(v) => onSetTweak("palette", v as Palette)} />

        <div className="twk-sect">侧栏样式 · Sidebar</div>
        <SegmentedRadio
          value={tweaks.sidebar}
          options={["rich", "minimal", "activity"]}
          onChange={(v) => onSetTweak("sidebar", v as SidebarMode)}
        />
      </div>
    </div>
  );
}
