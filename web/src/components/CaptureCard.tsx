"use client";

// Capture card: an agent of the chat took a screenshot or screen video of its chat browser with cbase_screenshot /
// cbase_recording_* — the server shows it by itself at the end of the turn. Screenshots open the full-screen viewer with zoom
// on click; videos play right in the card (range route). Above the per-turn cap (six) the card arrives with `collapsed` and
// shows as a header that opens on click — the same rule as iOS (ChatCards.swift CaptureCard).
import { useState } from "react";
import { API_BASE } from "@/lib/api";
import { ImageLightbox, VideoLightbox } from "@/components/ImageLightbox";
import { useT } from "@/lib/i18n";
import { imageFrame } from "@/lib/image-frame";
import { CARD, CARDS_HEADER } from "@/components/chat/StatusLine";

export interface CaptureMessage {
  captureId: string;
  kind: "screenshot" | "recording";
  caption?: string;
  poster?: string | null;
  video?: string | null;
  w?: number;
  h?: number;
  durationMs?: number;
  url?: string;
  title?: string;
  collapsed?: boolean; // above the per-turn cap: collapsed until the user opens it
}

const fileUrl = (chatId: string, captureId: string, name: string) =>
  `${API_BASE}/api/chats/${chatId}/captures/${encodeURIComponent(captureId)}/file/${name}`;

const fmtDuration = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} min` : `${s} s`;
};

export function CaptureCard({ chatId, capture }: { chatId: string; capture: CaptureMessage }) {
  const t = useT();
  const [zoom, setZoom] = useState(false);
  const [cinema, setCinema] = useState(false);
  const [closed, setClosed] = useState(capture.collapsed === true);
  const isVideo = capture.kind === "recording" && capture.video;
  const poster = fileUrl(chatId, capture.captureId, "poster.jpg");
  // The capture knows its dimensions (`w`/`h`), yet the image used to reserve no space — 2 px until loaded, then 327/384 px,
  // and the history that had just jumped to the end sat that much too high. Now the frame stands from the first paint: fitted
  // into 384 px height (`max-h-96`) and the column, never enlarged.
  const frame = imageFrame(capture.w, capture.h, 384, "100%");
  return (
    <div className={CARD}>
      <div className={closed ? CARDS_HEADER.replace("mb-2 ", "") : CARDS_HEADER}>
        <span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {isVideo
              ? <><rect x="2" y="5" width="14" height="14" rx="2" /><path d="M16 10l6-3v10l-6-3" /></>
              : <><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M8 21h8" /><path d="M12 18v3" /></>}
          </svg>
        </span>
        <span className="font-medium text-fg">{isVideo ? t("Screen recording") : t("Screenshot")}</span>
        {isVideo && (capture.durationMs ?? 0) > 0 && <span>{fmtDuration(capture.durationMs!)}</span>}
        {capture.title && <span className="min-w-0 truncate">· {capture.title}</span>}
        {capture.collapsed === true && (
          <button
            type="button"
            onClick={() => setClosed((v) => !v)}
            aria-expanded={!closed}
            className="ml-auto rounded-md px-1.5 py-0.5 text-dim transition hover:bg-hover hover:text-fg"
          >
            {closed ? t("Expand") : t("Collapse")}
          </button>
        )}
        {isVideo && !closed && (
          <button
            type="button"
            onClick={() => setCinema(true)}
            title={t("Fullscreen")}
            className={`${capture.collapsed === true ? "" : "ml-auto "}grid h-6 w-6 shrink-0 place-items-center rounded-md text-dim transition hover:bg-hover hover:text-fg`}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>
          </button>
        )}
      </div>
      {closed ? null : isVideo ? (
        <video
          controls
          playsInline
          preload="metadata"
          poster={poster}
          src={fileUrl(chatId, capture.captureId, "video.mp4")}
          className="max-h-96 w-full rounded-lg bg-black/90 object-contain"
          style={frame ? { aspectRatio: frame.aspectRatio } : undefined}
        />
      ) : (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={poster}
          alt={capture.caption || t("Screenshot")}
          className="max-h-96 max-w-full cursor-zoom-in rounded-lg border border-edge object-contain"
          style={frame ?? undefined}
          onClick={() => setZoom(true)}
        />
      )}
      {capture.caption && !closed && <div className="mt-2 text-[13px] text-fg">{capture.caption}</div>}
      {zoom && !isVideo && <ImageLightbox src={poster} alt={capture.caption || ""} onClose={() => setZoom(false)} />}
      {cinema && isVideo && (
        <VideoLightbox src={fileUrl(chatId, capture.captureId, "video.mp4")} poster={poster} onClose={() => setCinema(false)} />
      )}
    </div>
  );
}
