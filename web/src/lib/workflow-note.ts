// The note of a closed workflow run. Where the server writes a fixed sentence into it (store/workflows.js abandonWorkflowRuns: the chat
// was deleted), it is stored in English and the view translates it for display; any other note is shown as it is.
// Leaf module; the sentence is compared by workflows/graph-background.js on the server, so it changes only together with that.
export const CHAT_DELETED_NOTE = "Chat deleted";

export function runNoteShown(note: string, t: (key: string) => string): string {
  return note === CHAT_DELETED_NOTE ? t("Chat deleted") : note;
}
