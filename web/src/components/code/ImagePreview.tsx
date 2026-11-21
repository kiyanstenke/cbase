"use client";
// The image preview shown instead of "binary file" in the editor of the Files page (CodePane).
import { useState } from "react";
import { useT } from "@/lib/i18n";

const humanSize = (n: number) =>
  n < 1024 ? `${n} B`
    : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 / 1024).toFixed(1)} MB`;

// Checkerboard behind the image so transparency is visible; "Fit" only scales down (a 16×16
// icon must not be blown up to screen size), 1:1 shows real pixels and scrolls.
export function ImagePreview({ src, name, size, onDownload }: { src: string; name: string; size: number; onDownload: () => void }) {
  const t = useT();
  const [dim, setDim] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [full, setFull] = useState(false);
  const checker = "repeating-conic-gradient(var(--color-edge) 0% 25%, transparent 0% 50%) 50% / 16px 16px";
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-4" style={{ background: checker }}>
        {failed ? (
          <div className="flex h-full items-center justify-center text-[13px] text-dim">{t("Could not load image.")}</div>
        ) : (
          <div className={`flex min-h-full ${full ? "" : "items-center justify-center"}`}>
            {/* Deliberately <img>, not next/image: the file comes from the project folder, nobody knows
                its size in advance, and the static export has no image optimiser. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={name}
              onLoad={(e) => setDim({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              onError={() => setFailed(true)}
              className={full ? "max-w-none" : "max-h-full max-w-full object-contain"}
              style={full ? { imageRendering: "pixelated" } : undefined}
            />
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3 border-t border-edge px-3 py-1.5 text-[11.5px] text-dim">
        <span className="truncate">{name}</span>
        {dim && <span className="shrink-0 font-mono">{dim.w} × {dim.h}</span>}
        {size > 0 && <span className="shrink-0 font-mono">{humanSize(size)}</span>}
        <span className="flex-1" />
        <button onClick={() => setFull((v) => !v)} className="shrink-0 rounded-full px-2 py-0.5 font-medium transition-colors hover:bg-hover hover:text-fg">
          {full ? t("Fit") : t("1:1")}
        </button>
        <button onClick={onDownload} className="shrink-0 rounded-full px-2 py-0.5 font-medium transition-colors hover:bg-hover hover:text-fg">{t("Download")}</button>
      </div>
    </div>
  );
}
