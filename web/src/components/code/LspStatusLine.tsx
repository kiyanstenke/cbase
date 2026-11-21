"use client";

// The status line of the language service in the editor: language · state of the active file ("Python · ready", "TypeScript · starting
// …"); for Python the interpreter as well. A click opens the sheet: version, formatter, last error, "Restart" and "Stop"
// (`restart`/`stop`; stopping holds until the next use; sent with `file` so the server at workspace level finds the file's project).
// If the instance is stopped it says "Instance stopped — language features off" with the existing start path of the instances
// (lib/api/instances.ts `startInstance`; only the human starts); if the save gate is closed, "Low on memory — not started". A file
// without a server shows nothing; so long as the state has not been read, nothing either (empty is not unknown).
// For Python the interpreter is a separate button beside it: a click opens the choice (components/code/interpreter-choice.ts, the
// same as "Python: Select Interpreter" in the command palette); at workspace level only if the file belongs to a project.
import { useMemo, useState } from "react";
import { useT } from "@/lib/i18n";
import { LANGUAGE_NAMES, lspCalls, type LspState } from "@/lib/api";
import { startInstance } from "@/lib/api";
import { refreshLspStatus, useLspStatus } from "@/lib/lsp-status";
import { Menu, MenuEntry, MenuSeparator } from "@/components/CbKit";
import { interpreterPossible, selectInterpreter } from "@/components/code/interpreter-choice";
import { STATUS_ENTRY } from "@/components/code/StatusBar";

const STATE_WORD: Record<LspState, string> = {
  off: "off", starting: "starting …", ready: "ready", memory: "Low memory — not started",
  stopped: "Instance stopped — language features off", error: "Error", missing: "not installed",
};
// Same shape as every entry of the status bar (components/code/StatusBar.tsx).
const BUTTON = STATUS_ENTRY;

export function LspStatusLine({ apiBase, instance, path }: { apiBase: string; instance: string | null; path: string | null }) {
  const t = useT();
  const target = useMemo(() => ({ apiBase, instance }), [apiBase, instance]);
  const s = useLspStatus(target, path);
  const [notice, setNotice] = useState("");
  if (!s || !s.language || !s.loaded || !path) return null;
  const st = s.status;
  const state: LspState | null = st?.state ?? (s.not?.state ?? null);
  const name = LANGUAGE_NAMES[s.language];
  const projectId = /^\/api\/projects\/([^/]+)$/.exec(apiBase)?.[1] ?? null;
  const instanceName = instance ? instance.slice(instance.indexOf("/") + 1) : "main";
  const word = s.not?.reason === "no_project" ? t("no project — syntax colors only")
    : state ? t(STATE_WORD[state]) : s.error ? t("Error") : t("off");
  const interpreter = s.language === "python" && interpreterPossible(target, path) ? (st?.interpreter ? st.interpreter.split("/").slice(-3).join("/") : t("Select interpreter")) : null;
  const handle = async (f: () => Promise<unknown>) => {
    setNotice("");
    try { await f(); } catch (e) { setNotice(String((e as Error)?.message ?? e)); }
    await refreshLspStatus(target, path);
  };
  const color = state === "error" || state === "missing" ? "text-danger" : state === "memory" || state === "stopped" ? "text-warn" : "";
  return (<>
    <Menu
      label={t("Language service: {name}", { name })}
      alignment="right"
      width={300}
      button={{ className: `${BUTTON} ${color}`, content: <span className="truncate" data-lsp-status={state ?? ""}>{`${name} · ${word}`}</span>, data: { "data-lsp-status-line": "" } }}
    >
      <div className="px-2.5 pb-1 pt-1 text-[11.5px] leading-snug text-dim" onClick={(e) => e.stopPropagation()}>
        <div className="font-medium text-fg">{name} · {word}</div>
        {st?.version && <div>{t("Version {v}", { v: st.version })}</div>}
        {st?.formatter && <div>{t("Formatter: {f}", { f: st.formatter })}</div>}
        {st?.interpreter && <div className="break-all">{t("Interpreter: {p}", { p: st.interpreter })}</div>}
        {(st?.error || s.error || notice) && <div className="mt-1 break-words text-danger">{t("Last error: {msg}", { msg: notice || st?.error || s.error || "" })}</div>}
      </div>
      <MenuSeparator />
      {state === "stopped" && projectId ? (
        <MenuEntry label={t("Start instance")} onClick={() => void handle(() => startInstance(decodeURIComponent(projectId), instanceName))} />
      ) : (
        <>
          <MenuEntry label={t("Restart")} disabled={state === "stopped" || state === "missing"} onClick={() => void handle(() => lspCalls(target, "restart", { language: s.language, file: path }))} />
          <MenuEntry label={t("Stop##end")} disabled={state !== "ready" && state !== "starting" && state !== "error"} onClick={() => void handle(() => lspCalls(target, "stop", { language: s.language, file: path }))} />
        </>
      )}
    </Menu>
    {interpreter !== null && (
      <button type="button" onClick={() => selectInterpreter(target, path)} title={t("Python: Select Interpreter")} className={BUTTON} data-lsp-interpreter>
        <span className="truncate">{interpreter}</span>
      </button>
    )}
  </>);
}
