"use client";
// The buttons a diff tab places BEFORE its own (previous/next change, side by side/inline; components/code/DiffTab.tsx):
// ONE building block for the chat (chat/DiffTabSwitch.tsx, right in the title row) and the editor groups (CodePane, right in the
// group's tab bar). "Open file" as in VS Code `git.openFile` (codicon go-to-file): the diff's file as a file tab.
import { TitleButton } from "@/components/code/EditorTitleSymbols";

type T = (key: string, params?: Record<string, string | number>) => string;

export function FileOpenButton({ t, onClick }: { t: T; onClick: () => void }) {
  return <TitleButton name="go-to-file" title={t("Open file")} onClick={onClick} data={{ "data-diff-file-open": "" }} />;
}
