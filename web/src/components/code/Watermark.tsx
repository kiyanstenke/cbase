"use client";
// The watermark of an empty editor group, like VS Code: the emblem (the cbase lens logo — never the icon tile) and the shortcuts
// below it. Which ones are shown is computed by lib/watermark.ts exactly as VS Code 1.143 does; the shortcuts come from the ONE command
// table (lib/editor-commands.ts `command(id)?.shortcut`, registered by palette-host.ts and panel/code-layout.ts); a command without a key
// is not shown. Shuffling happens ONCE per group (VS Code: the watermark lives with the group): the caller keeps the draw (`thrown`) per
// group (CodePane `throwOf`) — re-mounting when the group becomes empty again does not reshuffle. Shortcuts only without editors in another
// group (`narrow`) and from 478 px height (CSS container query in globals.css). The key boxes are the SAME as in Quick Input
// (`.cb-qi-keys`/`.cb-qi-chord`/`.cb-qi-key`, colours `--qi-key-*` — VS Code `keybindingLabel.*`). The entries are not clickable, as in VS Code.
import { Fragment, useEffect, useMemo, useReducer, useState } from "react";
import { subscribeCommands, command } from "@/lib/editor-commands";
import { isMac } from "@/lib/chat-bar";
import { withShortcuts, keysParts, watermark } from "@/lib/watermark";

type T = (key: string, params?: Record<string, string | number>) => string;

/** A draw for the shuffle — the caller keeps it per group for as long as the group lives. */
export const newThrow = (): number[] => Array.from({ length: 8 }, () => Math.random());

export function Watermark({ t, othersWithEditors, thrown }: { t: T; othersWithEditors: boolean; thrown: readonly number[] }) {
  const [tickCount, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeCommands(tick), []);
  // The same draw gives the same order, even if a command is registered late.
  const [mac, setMac] = useState(true);
  useEffect(() => { setMac(isMac()); }, []);
  const rows = useMemo(() => {
    let i = 0;
    return watermark((id) => command(id)?.shortcut ?? null, () => thrown[i++ % thrown.length]);
  }, [thrown, tickCount]);
  const shortcutsOn = withShortcuts(othersWithEditors);
  return (
    <div className="cb-watermark" data-watermark data-narrow={shortcutsOn ? undefined : ""}>
      <div className="cb-watermark-surface">
        <div className="cb-watermark-content">
          <div className="cb-watermark-embossing" aria-hidden data-watermark-embossing />
          {shortcutsOn && (
            <div className="cb-watermark-shortcut" data-watermark-shortcut>
              {rows.map((z) => (
                <dl key={z.id} data-watermark-entry={z.id}>
                  <dt>{t(z.title)}</dt>
                  <dd><Keys shortcut={z.shortcut} mac={mac} /></dd>
                </dl>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** A shortcut like VS Code `KeybindingLabel`: one box per key, without separator on the Mac, otherwise "+"; chords spaced apart — in the
 *  Quick Input boxes (globals.css `.cb-qi-key`). */
export function Keys({ shortcut, mac }: { shortcut: string; mac: boolean }) {
  return (
    <span className="cb-qi-keys" aria-label={shortcut}>
      {keysParts(shortcut, mac).map((keys, a) => (
        <span key={a} className="cb-qi-chord">
          {keys.map((x, i) => (
            <Fragment key={i}>{!mac && i > 0 && <span aria-hidden>+</span>}<kbd className="cb-qi-key">{x}</kbd></Fragment>
          ))}
        </span>
      ))}
    </span>
  );
}
