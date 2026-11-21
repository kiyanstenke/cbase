"use client";

import { useEffect, useRef, useState } from "react";
import { ACCENT_DEFAULT, ACCENT_DEFAULTS, accentValues, normAccent, setAccent, useAccent } from "@/lib/accent";
import { useResolvedTheme } from "@/lib/theme";
import { accent, field, ghostSm } from "@/components/CbKit";
import { Group, Preview, Row } from "@/components/settings/SettingsKit";
import { useT } from "@/lib/i18n";

// Settings → Appearance → Accent colour. The calculation lives in `lib/accent.ts`; here only the choice (eight presets, custom
// colour, hex field, reset) and the preview. Like colour scheme and text size the choice takes effect at once, without a save
// button — it is a device preference.
//
// The swatches show the accent that really applies in the CURRENT design (in dark the derived lighter step), not the chosen base
// tone: what you click is what you get. The check mark in them is white — the derivation keeps white text legible on every accent.

function CheckMark() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function Plus() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

// A swatch: 28 px round, selected with an outline in text colour (an accent edge would be invisible on the accent) and a white
// check mark.
const FIELD = "relative grid h-7 w-7 shrink-0 place-items-center rounded-full text-white transition-transform hover:scale-110";
const SELECTED = "outline-2 outline-offset-2 outline-fg";

// The colour wheel of the "custom" field while no custom colour is chosen.
const RAINBOW = "conic-gradient(from 0deg, #e5484d, #f59e0b, #84cc16, #10b981, #06b6d4, #3b82f6, #8b5cf6, #ec4899, #e5484d)";

export function AccentColorSection() {
  const t = useT();
  const choice = useAccent(); // null = Standard
  const mode = useResolvedTheme() === "dark" ? "dark" : "light";
  const current = choice ?? ACCENT_DEFAULT;
  const preset = ACCENT_DEFAULTS.find((v) => v.hex === current);
  const values = accentValues(choice);

  // The hex field has a draft: typing must not jump on every half value. A change from outside (preset, colour picker, reset)
  // pulls it along.
  const [draft, setDraft] = useState(current);
  useEffect(() => setDraft(current), [current]);
  const invalid = draft.trim() !== "" && normAccent(draft) === null;

  // While dragging the colour picker reports every intermediate frame — applied at most once per frame (rewriting the style
  // element recolours the whole app).
  const frame = useRef<number | null>(null);
  const last = useRef<string | null>(null);
  // The colour picker is UNCONTROLLED. Controlled (`value={current}`) it jerked back while dragging: the state catches up only in
  // the next frame, React resets the DOM value to the old prop after every `input`, and Chromium passes that on to the open picker
  // (in Electron the NSColorPanel). Now the value belongs to the picker; only a change FROM OUTSIDE (preset, hex field, reset) is
  // set on it — recognised by not being the value it last applied itself and by no frame of it pending. No `key` change: a new
  // element would tear an open picker off the field.
  const picker = useRef<HTMLInputElement>(null);
  const fromPicker = useRef<string | null>(null);
  const [startColor] = useState(current);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
  useEffect(() => {
    const el = picker.current;
    if (!el || frame.current !== null || current === fromPicker.current) return;
    fromPicker.current = null;
    if (el.value !== current) el.value = current;
  }, [current]);
  const live = (hex: string) => {
    last.current = hex;
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (!last.current) return;
      fromPicker.current = normAccent(last.current);
      setAccent(last.current);
    });
  };

  const takeOver = () => {
    const v = normAccent(draft);
    if (v) setAccent(v);
    else setDraft(current);
  };

  return (
    <>
      {/* No group title: it would stand word for word above the row below (the same form as the text size on this page). */}
      <Group>
        <Row
          wide
          title={t("Accent color")}
          hint={t("Colors buttons, selections, links and highlights across the app — on this device only. The dark theme uses a lighter shade, the light theme a deeper one where needed, so white text on it stays readable.")}
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5" data-accent-choice={current}>
            <div className="flex flex-wrap items-center gap-2.5" role="group" aria-label={t("Accent color")}>
              {ACCENT_DEFAULTS.map((v) => {
                const on = v.hex === current;
                return (
                  <button
                    key={v.hex}
                    type="button"
                    onClick={() => setAccent(v.hex)}
                    aria-pressed={on}
                    aria-label={t(v.label)}
                    title={t(v.label)}
                    data-accent-default={v.hex}
                    className={`${FIELD} ${on ? SELECTED : ""}`}
                    style={{ background: accentValues(v.hex)[mode].accent }}
                  >
                    {on && <CheckMark />}
                  </button>
                );
              })}
            </div>

            <span aria-hidden className="h-5 w-px bg-edge" />

            {/* Custom colour: the native colour picker lies invisibly over the field — a click hits it itself, and Chrome's picker
                (or macOS's in Electron) opens where the field stands. */}
            <span
              className={`${FIELD} has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent ${!preset ? SELECTED : ""}`}
              style={{ background: preset ? RAINBOW : values[mode].accent }}
              title={t("Custom color")}
            >
              {preset ? <span className="grid h-4 w-4 place-items-center rounded-full bg-black/35"><Plus /></span> : <CheckMark />}
              <input
                ref={picker}
                type="color"
                defaultValue={startColor}
                onChange={(e) => live(e.target.value)}
                aria-label={t("Custom color")}
                data-accent-own
                className="absolute inset-0 h-full w-full cursor-pointer rounded-full opacity-0"
              />
            </span>
            <input
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                // A complete value takes effect while typing; a three-digit one only with Enter or on leaving — "#1f5" is already a
                // colour before you are done.
                if (/^#?[0-9a-f]{6}$/i.test(e.target.value.trim())) setAccent(e.target.value);
              }}
              onBlur={takeOver}
              onKeyDown={(e) => {
                if (e.key === "Enter") takeOver();
                if (e.key === "Escape") setDraft(current);
              }}
              spellCheck={false}
              autoComplete="off"
              maxLength={7}
              aria-label={t("Hex value of the accent color")}
              aria-invalid={invalid}
              title={invalid ? t("Not a valid color — expected #rrggbb.") : undefined}
              data-accent-hex
              className={`${field} w-[96px] font-mono ${invalid ? "text-danger" : ""}`}
            />

            <span className="flex-1" />
            <button type="button" className={ghostSm} disabled={!choice} onClick={() => setAccent(null)} data-accent-reset>
              {t("Reset")}
            </button>
          </div>
        </Row>
      </Group>

      {/* The preview carries the SAME classes as the app (kit button, markdown link, tinted surface) — it shows what the CSS
          really yields. Plus the two values derived from the choice: you see what the other design gets. */}
      <div className="mt-3">
        <Preview>
          <div className="flex flex-wrap items-center gap-3" aria-hidden data-accent-preview>
            <span className={accent}>{t("Adopt")}</span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-[12px] font-medium text-accent">
              <CheckMark />
              {t("Selected")}
            </span>
            <span className="text-[13px]">
              <span className="text-accent underline decoration-accent/45 underline-offset-2">{t("A link in the text")}</span>
            </span>
            <span className="inline-flex items-center gap-1.5 text-[12px] text-dim">
              <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
              {t("running")}
            </span>
          </div>
          <div className="cb-kit-pane cb-kit-pane-accent mt-3 rounded-xl px-3 py-2 text-[12.5px]" aria-hidden>
            {t("A highlighted surface — this is how running work and open proposals appear.")}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-dim" data-accent-values>
            {(["light", "dark"] as const).map((m) => (
              <span key={m} className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full border border-edge" style={{ background: values[m].accent }} />
                {t(m === "light" ? "Light" : "Dark")}
                <span className="font-mono">{values[m].accent}</span>
              </span>
            ))}
          </div>
        </Preview>
      </div>
    </>
  );
}
