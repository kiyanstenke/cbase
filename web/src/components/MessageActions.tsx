"use client";

// Action bar under EVERY message: copy (whole message) and read aloud. Deliberately always
// visible, not only on hover, so it is reachable on a phone at all and need not be hunted for
// on the desktop.
//
// No "resend" button: deliberately not wanted.
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { speakingKey, stopSpeaking, subscribeSpeaking, toggleSpeak } from "@/lib/tts";

export function MessageActions({
  messageKey,
  text,
  dark = false,
  copied,
  onCopy,
}: {
  /** Names the message (chat id + position); the speech state hangs on it. */
  messageKey: string;
  text: string;
  /** User bubble: dark background, hence lighter icons. */
  dark?: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  const t = useT();
  const [speaking, setSpeaking] = useState<string | null>(speakingKey);
  useEffect(() => subscribeSpeaking(setSpeaking), []);
  // If the bubble leaves the view (chat switch), it must not keep talking.
  useEffect(() => () => { if (speakingKey() === messageKey) stopSpeaking(); }, [messageKey]);

  if (!text.trim()) return null;
  const isSpeaking = speaking === messageKey;
  const tone = dark
    ? "text-white/60 hover:bg-white/15 hover:text-white"
    : "text-dim hover:bg-hover hover:text-fg";

  // `data-message-actions`: history-edge.mjs uses it to check that the metrics row comes BEFORE it.
  return (
    <div className="mt-1 flex items-center gap-0.5" data-message-actions>
      <button
        type="button"
        onClick={onCopy}
        title={copied ? t("Copied") : t("Copy message")}
        aria-label={copied ? t("Copied") : t("Copy message")}
        className={`grid h-7 w-7 place-items-center rounded-lg transition-colors ${tone}`}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      <button
        type="button"
        onClick={() => { toggleSpeak(messageKey, text).catch(console.error); }}
        title={isSpeaking ? t("Stop reading") : t("Read aloud")}
        aria-label={isSpeaking ? t("Stop reading") : t("Read aloud")}
        className={`grid h-7 w-7 place-items-center rounded-lg transition-colors ${
          isSpeaking ? (dark ? "bg-white/15 text-white" : "bg-hover text-accent") : tone
        }`}
      >
        {isSpeaking ? <SpeakerStopIcon /> : <SpeakerIcon />}
      </button>
    </div>
  );
}

const CopyIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="9" y="9" width="11" height="11" rx="2.5" />
    <path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H6.5A3.5 3.5 0 0 0 3 6.5v6A2.5 2.5 0 0 0 5.5 15" />
  </svg>
);

const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

const SpeakerIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M11 5 6.5 9H3v6h3.5L11 19z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    <path d="M18.5 5.5a9 9 0 0 1 0 13" />
  </svg>
);

// While speech runs, the button shows stop (filled square in the speaker slot).
const SpeakerStopIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M11 5 6.5 9H3v6h3.5L11 19z" />
    <rect x="14.5" y="9" width="6" height="6" rx="1.2" fill="currentColor" stroke="none" />
  </svg>
);
