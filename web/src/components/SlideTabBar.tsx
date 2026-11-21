"use client";

export type SlideTab = {
  key: string;
  label: string;
  count?: number;
  icon?: React.ReactNode;
  variant?: "neutral" | "accent"; // accent = project-bound tabs (e.g. Code)
  dividerBefore?: boolean;
  title?: string;
};

// Tab bar as a capsule rail: the active tab carries the capsule ITSELF — dark, or accent for an accent tab.
// There is no sliding pill (so no measured pill and no ResizeObserver): the capsule sits at the new tab at once, only
// background and text fade via `transition-colors` (150 ms). The content below fades in via the page itself
// (`cb-tab-enter` / `AnimatedSwitch`, globals.css).
export function SlideTabBar({
  tabs,
  active,
  onSelect,
  className,
  track = "bg",
  fill = false,
}: {
  tabs: SlideTab[];
  active: string;
  onSelect: (key: string) => void;
  className?: string;
  // Background of the tab rail: "bg" (default, on panel surfaces) or "panel" (on the page background,
  // where bg-bg is invisible; panel + border gives a visible segmented control).
  track?: "bg" | "panel";
  // All tabs share the available width evenly. Compact main navigations keep the content-width
  // default; sidebars use the full rail.
  fill?: boolean;
}) {
  return (
    // min-w-0 + cb-strip: the workspace has up to 13 tabs, which do not fit one line in a narrow window.
    // With shrink-0 alone the bar pushed everything to its right (service pills, ports) out of the window.
    // Now it scrolls horizontally and keeps its height; the capsule hangs on the button and scrolls with it.
    <div className={`cb-strip relative flex min-w-0 shrink items-center gap-0.5 overflow-x-auto rounded-full p-0.5 ${track === "panel" ? "border border-edge bg-panel" : "bg-bg"} ${className ?? ""}`}>
      {tabs.map((t) => {
        const isActive = t.key === active;
        const accent = t.variant === "accent";
        const text = isActive
          ? `text-white ${accent ? "bg-accent" : "bg-dark"}`
          : accent
            ? "text-accent hover:text-accent"
            : "text-dim hover:text-fg";
        return (
          <span key={t.key} className={`flex items-center ${fill ? "min-w-0 flex-1" : ""}`}>
            {t.dividerBefore && <span className="mx-1 h-4 w-px shrink-0 self-center bg-edge" />}
            <button
              onClick={() => onSelect(t.key)}
              title={t.title}
              className={`relative flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors duration-150 ${fill ? "min-w-0 flex-1 justify-center" : "shrink-0"} ${text}`}
            >
              {t.icon}
              {t.label}
              {isActive && t.count !== undefined ? ` (${t.count})` : ""}
            </button>
          </span>
        );
      })}
    </div>
  );
}
