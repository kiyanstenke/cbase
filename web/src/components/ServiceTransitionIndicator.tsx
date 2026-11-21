"use client";

import { useT } from "@/lib/i18n";

export type ServiceTransition = "starting" | "stopping";

export function ServiceTransitionIndicator({ kind }: { kind: ServiceTransition }) {
  const t = useT();
  const label = kind === "starting" ? t("Starting") : t("Stopping");

  return (
    <span
      role="status"
      aria-label={label}
      className={`inline-flex cursor-wait items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
        kind === "starting"
          ? "bg-dark text-white"
          : "border border-edge text-danger"
      }`}
    >
      {label}
      <span aria-hidden className="inline-flex items-center font-mono text-[11px]">
        (
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="inline-block animate-pulse"
            style={{ animationDelay: `${dot * 160}ms`, animationDuration: "800ms" }}
          >
            .
          </span>
        ))}
        )
      </span>
    </span>
  );
}
