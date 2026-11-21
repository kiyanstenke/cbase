"use client";

// Settings page "Third-party notices": what cbase has taken over from others — name, author, license with reference,
// source (repo and tag), changes, and per item the path in the repo with cbase's files (lib/thirdParty.ts, the same
// list as web/public/THIRD_PARTY_NOTICES.txt). Not a page of the groups (SETTINGS_GROUPS, bound to iOS): it stands as
// its own row at the bottom of the settings list (SettingsModal.tsx `HINTS`), like "About" in other programs.
import { Group, Row } from "@/components/settings/SettingsKit";
import { useT } from "@/lib/i18n";
import { ATTRIBUTIONS, HINTS, HINT_FILE, PACKAGES, originOf, sourceOf } from "@/lib/thirdParty";

const reference = "text-accent underline-offset-2 hover:underline";

export function ThirdPartyHints() {
  const t = useT();
  return (
    <div data-third-party>
      {HINTS.map((h) => (
        <Group key={h.name} title={h.name}>
          <Row title={t("Author")}><span className="text-[12.5px]">{h.originator}</span></Row>
          <Row title={t("License")} wide>
            <a className={`text-[12.5px] ${reference}`} href={h.licenseUrl} target="_blank" rel="noreferrer" data-third-party-license>{h.license}</a>
          </Row>
          <Row title={t("Source")} hint={originOf(h)} wide>
            <a className={`text-[12.5px] ${reference}`} href={sourceOf(h)} target="_blank" rel="noreferrer">{sourceOf(h).replace(/^https:\/\//, "")}</a>
          </Row>
          <Row title={t("Changes")} hint={h.changes.map((a) => t(a)).join(" · ")} />
          {h.chunks.map((s) => (
            <Row key={`${s.kind}:${s.path}`} title={<span className="font-mono text-[12px]" data-third-party-chunk>{s.path}</span>}
              hint={<>{t(s.kind === "Port of" ? "Reimplementation" : "Taken over")} · {t(s.what)} · <span className="font-mono">{s.files.join(", ")}</span></>} />
          ))}
        </Group>
      ))}
      {/* Courtesy attributions (no license condition, or data too small for one) — name, author, license, home, use, files. */}
      <Group title={t("Further attributions")}>
        {ATTRIBUTIONS.map((a) => (
          <Row key={a.name} title={<span data-third-party-attribution>{a.name}</span>}
            hint={<>{a.originator} · <a className={reference} href={a.licenseUrl} target="_blank" rel="noreferrer">{a.license}</a> · {t(a.what)} · <span className="font-mono">{a.files.join(", ")}</span></>} wide>
            <a className={`text-[12.5px] ${reference}`} href={a.source} target="_blank" rel="noreferrer">{a.source.replace(/^https:\/\//, "")}</a>
          </Row>
        ))}
      </Group>
      {/* Packages cbase ships unchanged (license checked) — name, version, license, repo. */}
      <Group title={t("Backend packages")}>
        {PACKAGES.map((p) => (
          <Row key={p.name} title={<span className="font-mono text-[12px]" data-third-party-package>{p.name} {p.version}</span>} hint={p.license} wide>
            <a className={`text-[12.5px] ${reference}`} href={`https://github.com/${p.repo}`} target="_blank" rel="noreferrer">{`github.com/${p.repo}`}</a>
          </Row>
        ))}
      </Group>
      <Group>
        <Row title={t("Full text including licenses")} hint="THIRD_PARTY_NOTICES.txt">
          <a className={`text-[12.5px] ${reference}`} href={HINT_FILE} target="_blank" rel="noreferrer" data-third-party-file>{t("Open")}</a>
        </Row>
      </Group>
    </div>
  );
}
