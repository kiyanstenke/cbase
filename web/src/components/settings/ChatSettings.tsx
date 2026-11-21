"use client";

// The "Chats" page: archive chats automatically — one setting for all workspaces. Counterpart on iOS: Settings/ChatSettings (the
// same group, the same page — bound in web/test/settings-form.test.mjs).
//
// Two values, ONE body: the PUT always carries `on` AND `days` (the route requires both, "a missing field is no statement"). An
// invalid number of days (not an integer from 1 to 365) does not go out — the field jumps back to the shown value, like the number
// fields of the usage page.
//
// Saved through `autoArchiveStorage` (lib/archive.ts): ONE local state, set at once, every job reads it at the moment of its run,
// the jobs run one after the other. Otherwise every action built its body from the last server answer — typing days and clicking
// the toggle straight away took the just-typed days back. An error resets to the last confirmed state and shows the error line.
import { useEffect, useState } from "react";
import { loadChatAutoArchive, setChatAutoArchive, type ChatAutoArchive } from "@/lib/api";
import { AUTO_ARCHIVE_DAYS, archiveDays, autoArchiveStorage } from "@/lib/archive";
import { useT } from "@/lib/i18n";
import { Toggle, field } from "@/components/CbKit";
import { Group, Row } from "@/components/settings/SettingsKit";

export function ChatSettings() {
  const t = useT();
  // `null` = not loaded yet: claim neither "off" nor "30 days", which the server may not even be running.
  const [status, setStatus] = useState<ChatAutoArchive | null>(null);
  const [daysDraft, setDaysDraft] = useState("");
  const [error, setError] = useState("");
  // The store holds the local state (the ref every action reads) and the chain of PUTs; `show` sets toggle and field.
  const [storage] = useState(() => autoArchiveStorage(setChatAutoArchive, {
    show: (s: ChatAutoArchive) => { setStatus(s); setDaysDraft(String(s.days)); },
    error: setError,
  }));

  useEffect(() => {
    loadChatAutoArchive()
      .then((s) => storage.loaded(s))
      .catch((e) => setError(String((e as Error).message)));
  }, [storage]);

  function daysSave(raw: string) {
    const now = storage.state();
    if (!now) return;
    const n = archiveDays(raw);
    if (n === null || n === now.days) { setDaysDraft(String(now.days)); return; }
    void storage.change({ days: n });
  }

  function toggle() {
    const now = storage.state();
    if (now) void storage.change({ enabled: !now.enabled });
  }

  return (
    <div data-chat-auto-archive>
      <Group>
        <Row
          title={t("Archive chats automatically")}
          hint={t("Pinned chats and chats with open work stay. Nothing is deleted.")}
        >
          <Toggle on={status?.enabled ?? false} onClick={toggle} disabled={status === null} />
        </Row>
        <Row title={t("Archive after")} hint={t("Whole days from 1 to 365. Applies to the chats of all workspaces.")}>
          <span className="flex items-center gap-2">
            <input
              type="number" min={AUTO_ARCHIVE_DAYS.min} max={AUTO_ARCHIVE_DAYS.max} step={1}
              value={daysDraft} disabled={!status}
              aria-label={t("days without a new message")}
              onChange={(e) => setDaysDraft(e.target.value)}
              onBlur={(e) => daysSave(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              className={`${field} w-[72px] text-right tabular-nums`}
            />
            <span className="whitespace-nowrap text-[12.5px] text-dim">{t("days without a new message")}</span>
          </span>
        </Row>
      </Group>
      {error && <span className="block px-1 pt-1 text-[12px] text-danger">{error}</span>}
    </div>
  );
}
