// A leaf module without imports (run in web/test/chat-rail.test.mjs).
/**
 * A chat's shortcut for the rail of the collapsed list, so every chat still gets an icon: the initials of the first two words, upper
 * case: “Main ORBIT” → “MO”, one word → its first two characters (“deploy” → “DE”). Words are runs of letters and digits; punctuation
 * separates. Without a word: “·”.
 */
export function chatShortcut(title: string): string {
  const [a, b] = (title.match(/[\p{L}\p{N}]+/gu) ?? []).map((w): string[] => Array.from(w));
  if (!a) return "·";
  const k = b ? a[0] + b[0] : a.slice(0, 2).join("");
  return k.toLocaleUpperCase();
}
