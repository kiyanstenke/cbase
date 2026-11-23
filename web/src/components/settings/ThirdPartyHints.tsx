"use client";

// Settings page "Third-party notices": what cbase has taken over from others — name, author, license with reference,
// source (repo and tag), changes, and per item the path in the repo with cbase's files (lib/thirdParty.ts, the same
// list as web/public/THIRD_PARTY_NOTICES.txt). Not a page of the groups (SETTINGS_GROUPS, bound to iOS): it stands as
// its own row at the bottom of the settings list (SettingsModal.tsx `HINTS`), like "About" in other programs — and at its top
// the group "About": which cbase build runs, its API level, the gateway and the desktop app (lib/about.ts).
import { useEffect, useState } from "react";
import { Group, Row } from "@/components/settings/SettingsKit";
import { aboutRows, type VersionInfo } from "@/lib/about";
import { useGateway } from "@/lib/gateway";
import { useT } from "@/lib/i18n";
import { shellAppVersion } from "@/lib/shell-bridge";
import { ATTRIBUTIONS, HINTS, HINT_FILE, PACKAGES, PROJECT, originOf, sourceOf } from "@/lib/thirdParty";

const reference = "text-accent underline-offset-2 hover:underline";

export function ThirdPartyHints() {
  const t = useT();
  return (
    <div data-third-party>
      <AboutGroup />
      {/* cbase's own licence and source (AGPL-3.0, section 13: network users can get the source). */}
      <Group title="cbase">
        <Row title={t("License")} wide>
          <a className={`text-[12.5px] ${reference}`} href={PROJECT.licenseUrl} target="_blank" rel="noreferrer" data-project-license>{PROJECT.license}</a>
        </Row>
        <Row title={t("Source code")} wide>
          <a className={`text-[12.5px] ${reference}`} href={PROJECT.source} target="_blank" rel="noreferrer" data-project-source>{PROJECT.source.replace(/^https:\/\//, "")}</a>
        </Row>
      </Group>
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

// The versions: in gateway mode from `/gw/info` (already fetched by the gate, `useGateway().info`), on the local server from
// `GET /api/version`. What is missing reads "unknown" — never a number from somewhere else. `undefined` = still loading.
function AboutGroup() {
  const t = useT();
  const gw = useGateway();
  const [local, setLocal] = useState<VersionInfo | null | undefined>(undefined);
  const [desktop, setDesktop] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (gw) return;
    let live = true;
    fetch("/api/version", { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((j) => { if (live) setLocal(j && typeof j === "object" ? (j as VersionInfo) : null); });
    return () => { live = false; };
  }, [gw]);

  useEffect(() => {
    let live = true;
    shellAppVersion(window).then((v) => { if (live) setDesktop(v); });
    return () => { live = false; };
  }, []);

  const loading = !gw && local === undefined;
  const rows = aboutRows({ server: gw ? gw.info : local ?? null, gatewayMode: !!gw, desktop });
  return (
    <Group title={t("About")}>
      {rows.map((r) => (
        <Row key={r.key} title={t(r.label)}>
          <span className="font-mono text-[12.5px] tabular-nums" data-about={r.key}>
            {loading && r.key !== "desktop" ? "…" : r.value === null ? t("unknown") : r.note ? `${r.value} (${t(r.note)})` : r.value}
          </span>
        </Row>
      ))}
    </Group>
  );
}
