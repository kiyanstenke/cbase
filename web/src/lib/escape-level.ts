// Who owns a press of Escape? A sheet of the administration (kit `Modal`, create,
// password, delete) lies OVER the settings, and both listened on `window` — the settings first (registered earlier). Escape
// in the password field thereby closed the WHOLE settings including the input.
//
// The rule:
//   · The kit `Modal` listens on `document` (bubble phase). That lies on the path BEFORE `window` — so it comes before the settings
//     whatever the registration order — and AFTER the React root (Next.js attaches it to `document`, registered
//     earlier): an element in the sheet that takes Escape itself comes first.
//   · It takes the press only if nobody took it before — neither consumed (`preventDefault`) nor stopped
//     (`stopPropagation`; renaming in the layout editor keeps its field open that way, projects/ProjectLayout.tsx). Deliberately NO
//     capture phase with `stopImmediatePropagation`: it would come before every element in the sheet, and exactly this renaming would close
//     the whole create dialog.
//   · If it takes it, it calls `preventDefault` — the settings (`window`) leave a consumed press alone.
//   · Of several open kit modals only the TOPMOST (last opened; the stack stands in CbKit.tsx) takes it.
//
// A leaf without imports; guard web/test/administration-proofread.test.mjs.

export type EscapePress = Pick<KeyboardEvent, "key" | "defaultPrevented" | "cancelBubble">;

/** Does a sheet (or the settings) take this press? Only Escape, and only if no element below has already taken it. */
export function sheetTakesEscape(e: EscapePress): boolean {
  return e.key === "Escape" && !e.defaultPrevented && !e.cancelBubble;
}
