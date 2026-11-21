"use client";

import { setThemeMode, useThemeMode, type ThemeMode } from "@/lib/theme";
import { MoonIcon, SunIcon, SystemIcon } from "@/components/ThemeToggle";
import { Overline } from "@/components/CbKit";
import { TextSizeSlider, useTextSizeHint } from "@/components/TextSize";
import { Preview, ChoiceCard } from "@/components/settings/SettingsKit";
import { AccentColorSection } from "@/components/settings/AccentColorSection";
import { useT } from "@/lib/i18n";

// Settings page "Appearance": the text size of the whole app and the colour scheme. Both are device preferences (localStorage),
// both take effect at once — no save button, as with "Language". Both also have a quick access in the header's "Display" menu; here
// they stand because "how does the app look" should be ONE place.
//
// The text size stands on TOP and applies to the whole app. On top because the app itself is the preview: under the design cards
// the bar slid away 54 px from under the pointer when switching. The control row therefore stands in `cb-text-fixed` (factor 1) —
// everything above has fixed height (the modal's header: 32 px button), everything that grows along stands below. The heading
// "Text size" does grow along like "Design" below it (otherwise two section headings of the same page were 10 and 12.3 px at
// "Very large"): it stands in a box of fixed height that already holds the largest step, aligned at the bottom — so it grows
// upward into the box, and the control row below stays on the same pixel at every step.

const DESIGN: { mode: ThemeMode; label: string; hint: string; Icon: typeof SunIcon }[] = [
  { mode: "light", label: "Light", hint: "Always light", Icon: SunIcon },
  { mode: "dark", label: "Dark", hint: "Always dark", Icon: MoonIcon },
  { mode: "system", label: "System", hint: "Follow the operating system", Icon: SystemIcon },
];

export function AppearanceSettings() {
  const t = useT();
  const mode = useThemeMode();
  const textSizeHint = useTextSizeHint();

  return (
    <div>
      {/* ── Text size of the whole app ── */}
      <section data-set-text-size>
        {/* 26 px: the overline at "Very large" (10 px × 1.226 × 1.55 line height ≈ 19 px) plus its gap (6 px). */}
        <div className="flex h-[26px] flex-col justify-end" data-text-size-header>
          <Overline>{t("Text size")}</Overline>
        </div>
        <div className="cb-text-fixed text-[13px]">
          <div className="cb-kit-pane rounded-2xl px-2.5 py-2">
            <TextSizeSlider />
          </div>
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-dim" data-text-size-hint>
          {textSizeHint}
        </p>
        {/* The preview is a hierarchy sample with the app's REAL classes: a card heading (15 px semibold), a paragraph (13 px), a
            muted meta line (11 px), a line of chat prose (`cb-chat-text`) and a code block (`cb-cs-13`). All five grow in the same
            proportion — so the "relative" is visible at a glance, without a re-creation with its own calculation. */}
        <div className="mt-3">
          <Preview>
            <div data-preview>
              <div className="text-[15px] font-semibold tracking-tight">{t("Card heading")}</div>
              <p className="mt-1 text-[13px] leading-relaxed">
                {t("A paragraph as it appears in lists, cards and dialogs — it grows in the same proportion as the heading above.")}
              </p>
              <div className="mt-1 text-[11px] text-dim">{t("Meta line · 3 minutes ago")}</div>
              <div className="cb-chat-text mt-3 border-t border-edge pt-3 leading-[1.7]">
                <p>
                  {t("This is how a reply reads in the conversation — paragraphs, lists and quotes at this size, plus")}{" "}
                  <code className="rounded-md bg-code px-1.5 py-px font-mono text-[0.9em]">npm run build</code>{" "}
                  {t("as inline code.")}
                </p>
                <pre className="cb-cs-13 mt-2 overflow-x-auto rounded-lg border border-edge bg-code p-3 font-mono leading-[1.5]">
                  <code>{"const response = await agent.run(task);\nconsole.log(response.text);"}</code>
                </pre>
              </div>
            </div>
          </Preview>
        </div>
      </section>

      {/* ── Colour scheme ──
          The sentence applies to BOTH sections; it is the place that says WHERE the choice is stored (the text size only says
          "on this device"). */}
      <section className="mt-6">
        <Overline>{t("Theme")}</Overline>
        <p className="-mt-0.5 mb-2 text-[11.5px] leading-relaxed text-dim">
          {t("Color scheme and text size apply to this device and browser — they are stored here, not on the server.")}
        </p>
        <div className="grid grid-cols-3 gap-2.5">
          {DESIGN.map(({ mode: m, label, hint, Icon }) => (
            <ChoiceCard
              key={m}
              icon={<Icon size={17} />}
              title={t(label)}
              hint={t(hint)}
              active={mode === m}
              onClick={() => setThemeMode(m)}
              // Measuring mark: a DOM probe in a real browser clicks the button through it. A mark that silently disappears with a
              // rebuild takes the statement away from the test stand.
              data={{ "data-design": m }}
            />
          ))}
        </div>
      </section>

      {/* ── Accent colour — choice, preview and calculation in AccentColorSection / lib/accent.ts ── */}
      <AccentColorSection />
    </div>
  );
}
