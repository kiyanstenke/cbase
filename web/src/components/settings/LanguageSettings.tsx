"use client";

import { Overline } from "@/components/CbKit";
import { ChoiceCard } from "@/components/settings/SettingsKit";
import { setLang, useLang, useT, type Lang } from "@/lib/i18n";
import { DE } from "@/lib/i18n-de";

// Settings page "Language": switch German/English. Takes effect at once on the whole interface (useT re-render) and reports the
// choice to the backend.
//
// Each card carries ONE real sentence from the interface in its language: "switching language" is the only setting whose effect
// you see only once it has happened — and whoever cannot read the other language cannot find the way back. The sentence is
// therefore no invented example but the dictionary entry itself: the English text is the key (see `lib/i18n.ts`), the German
// card shows its translation.

const OPTIONS: { value: Lang; label: string; native: string }[] = [
  { value: "de", label: "German", native: "Deutsch" },
  { value: "en", label: "English", native: "English" },
];

// A status line from the chat: short enough for a card, long enough to show sentence structure instead of a single word. It MUST
// be in the dictionary — otherwise the German card would fall back to the English key and show the same twice.
const EXAMPLE = "The agent is reading the project folder…";

export function LanguageSettings() {
  const t = useT();
  const lang = useLang();

  return (
    <div>
      <section>
        <Overline>{t("Interface language")}</Overline>
        <p className="-mt-0.5 mb-2 text-[11.5px] leading-relaxed text-dim">
          {t(
            "Applies to the entire interface and server-side messages. The agent still replies in whatever language you write in.",
          )}
        </p>

        <div className="grid grid-cols-2 gap-2.5">
          {OPTIONS.map((o) => (
            <ChoiceCard
              key={o.value}
              title={o.native}
              hint={t(o.label)}
              active={lang === o.value}
              onClick={() => setLang(o.value)}
            >
              <span
                lang={o.value}
                data-language-probe={o.value}
                className="block rounded-xl bg-bg px-3 py-2 text-[12px] font-normal leading-snug text-dim"
              >
                {o.value === "de" ? (DE[EXAMPLE] ?? EXAMPLE) : EXAMPLE}
              </span>
            </ChoiceCard>
          ))}
        </div>
      </section>
    </div>
  );
}
