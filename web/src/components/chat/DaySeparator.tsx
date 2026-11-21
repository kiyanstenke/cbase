// Day divider in the history: before the first row of a new calendar day, a wavy hairline with the day centred, then the
// wave again. The computation (which row, which day) lives ONCE in lib/day-separator.ts (`dayMarkers`); the iOS twin is
// Chat/DaySeparator.swift. The wave is an SVG pattern in `currentColor` (`text-dim`), so light and dark share one token.
import { useId } from "react";
import { useT, dateLocale } from "@/lib/i18n";
import type { DayMarker } from "@/lib/day-separator";

/** The visible text: "Today", "Yesterday", else "Wednesday, 4 November" (year only outside the current one). */
export function dayText(m: DayMarker, t: (k: string) => string, locale = dateLocale()): string {
  if (m.kind === "today") return t("Today");
  if (m.kind === "yesterday") return t("Yesterday");
  return new Date(m.ms).toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long", ...(m.withYear ? { year: "numeric" } : {}) });
}

function Wave() {
  const id = `wave-${useId().replace(/:/g, "")}`;
  return (
    <svg className="h-[6px] min-w-6 flex-1" aria-hidden="true">
      <defs>
        <pattern id={id} width="12" height="6" patternUnits="userSpaceOnUse">
          <path d="M0 3 Q3 0.5 6 3 T12 3" fill="none" stroke="currentColor" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="100%" height="6" fill={`url(#${id})`} />
    </svg>
  );
}

export function DaySeparator({ marker }: { marker: DayMarker }) {
  const t = useT();
  return (
    <div className="flex items-center gap-3 text-[12.5px] leading-5 text-dim" data-day-separator={marker.day} role="separator">
      <span className="flex flex-1 opacity-60"><Wave /></span>
      <span className="shrink-0 whitespace-nowrap tabular-nums">{dayText(marker, t)}</span>
      <span className="flex flex-1 opacity-60"><Wave /></span>
    </div>
  );
}
