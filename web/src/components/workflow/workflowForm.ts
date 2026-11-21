// The form classes of the editor sheets — node dialog, workflow settings, trigger component — in ONE
// place. `fieldFull`, `marker` and `iconBtn` used to be duplicated character for character in the
// editor AND the dialog, and a density change had to touch every measure twice; change the next
// measure here and all three sheets follow.
//
// A leaf module: imports only `field` from the kit, nothing from the editor, dialog or trigger
// component (cycle guard web/test/import-cycles.test.mjs). The kit itself must not change, so the
// density is a local derivation, not a new kit step.
import { field } from "@/components/CbKit";

// The kit field, 28 px high (4 + 20 + 4) and 12.5 px — the kit stays at 13 px/py-1.5. With `!`,
// because Tailwind orders equivalent utilities by value: `py-1` and `text-[12.5px]` would land in the
// bundle BEFORE the kit's `py-1.5` and `text-[13px]` and lose — an appended `py-1` would be a claim
// that never arrives.
export const fieldDense = `${field} py-1! text-[12.5px]! leading-5`;
// Inset field (well) across the full width — for titles, texts and choices of the sheets.
export const fieldFull = `${fieldDense} w-full`;
// The marker above a field (label of a well, not of an options row — that one sits at 12 px).
export const marker = "text-[11.5px] font-medium text-dim";
// Round icon button of the headers (gear, ×): 28 px, the same measure as the fields.
export const iconBtn = "grid h-7 w-7 place-items-center rounded-full bg-bg text-dim transition-colors hover:bg-hover hover:text-fg";
