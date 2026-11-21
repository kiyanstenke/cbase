// Read a message aloud (the "Read aloud" button under every bubble).
//
// Two voices, one control: if the settings hold an ElevenLabs key, `POST /api/tts` delivers the finished MP3 (the server damps
// Markdown into speech text and puts the result in its cache so the same message does not cost twice). Without a key the route
// answers 409 — then the browser's system voice takes over. So the button works without any setup, and with a key it sounds better.
//
// Only ONE message speaks at a time: a second click on the same one stops, a click on another takes over. The state deliberately
// lives in the module (not in React) because the audio outlives the bubble — a collapsed message must not abort the speech.
import { API_BASE } from "./api";

type Listener = (key: string | null) => void;

let currentKey: string | null = null;
let stopCurrent: (() => void) | null = null;
const listeners = new Set<Listener>();

function announce(key: string | null) {
  currentKey = key;
  for (const fn of [...listeners]) {
    try { fn(key); } catch (err) { console.error(err); }
  }
}

export function speakingKey(): string | null {
  return currentKey;
}

export function subscribeSpeaking(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Stop the running output (button pressed again, other message, chat switch). */
export function stopSpeaking(): void {
  const stop = stopCurrent;
  stopCurrent = null;
  if (stop) stop();
  if (currentKey !== null) announce(null);
}

/** The browser's system voice — the way without a key. */
function speakWithSystemVoice(key: string, text: string) {
  const synth = window.speechSynthesis;
  if (!synth) throw new Error("No system voice available");
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  // Language from the document (the app writes it along on language switch).
  utterance.lang = document.documentElement.lang === "en" ? "en-US" : "de-DE";
  utterance.onend = () => { if (currentKey === key) announce(null); };
  utterance.onerror = () => { if (currentKey === key) announce(null); };
  stopCurrent = () => synth.cancel();
  announce(key);
  synth.speak(utterance);
}

/**
 * Turn reading aloud on or off. `key` names the message (chat id + position), `text` is its plain text. Throws only if both
 * ways fail — the caller then shows it.
 */
export async function toggleSpeak(key: string, text: string): Promise<void> {
  if (currentKey === key) { stopSpeaking(); return; }
  stopSpeaking();
  const spoken = text.trim();
  if (!spoken) return;

  let audioUrl: string | null = null;
  try {
    const res = await fetch(`${API_BASE}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: spoken }),
    });
    if (res.ok) {
      audioUrl = URL.createObjectURL(await res.blob());
    } else if (res.status !== 409) {
      // No key (409) is the planned way to the system voice; anything else is a real error — but even then better to speak
      // than stay silent.
      console.warn("Read aloud via the server failed:", res.status);
    }
  } catch (err) {
    console.warn("Read aloud via the server unreachable:", err);
  }

  if (!audioUrl) { speakWithSystemVoice(key, spoken); return; }

  const audio = new Audio(audioUrl);
  const release = () => URL.revokeObjectURL(audioUrl!);
  audio.onended = () => { release(); if (currentKey === key) announce(null); };
  audio.onerror = () => { release(); if (currentKey === key) announce(null); };
  stopCurrent = () => { audio.pause(); release(); };
  announce(key);
  try {
    await audio.play();
  } catch (err) {
    // Autoplay block or broken audio → system voice.
    release();
    stopCurrent = null;
    console.warn("MP3 could not be played, falling back to the system voice:", err);
    speakWithSystemVoice(key, spoken);
  }
}
