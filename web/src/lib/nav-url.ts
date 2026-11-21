// Address bar input → navigable URL, for the client's NATIVE browser.
//
// The source of this rule is the backend: `normalizeNavUrl` in server/backend/electron/server/browsers.js (the streamed browser
// normalizes server-side in `act navigate`). The native browser loads in the client process what the web gives it — so the web must
// normalize itself, and with the SAME rule: "localhost:3000" is a host with a port, not a scheme; local addresses get http, foreign
// ones https; whatever contains whitespace or has neither a dot nor host:port nor is local becomes a Google search.
//
// This is a copy, and copies drift apart. The binding is the test web/test/nav-url-binding.test.mjs: it imports the backend's function
// and compares both on a table of inputs. Whoever changes a line here changes it there — or the test says which input behaves
// differently.
export function normalizeNavUrl(input: string): string {
  const u = String(input || "").trim();
  if (!u) return u;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(u)
    || /^(about|data|chrome|chrome-extension|devtools|file|view-source|blob|javascript|mailto):/i.test(u);
  if (hasScheme) return u;
  const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/i.test(u);
  const hostPort = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+):\d+([/?#]|$)/i.test(u);
  if (/\s/.test(u) || (!u.includes(".") && !hostPort && !local)) {
    return `https://www.google.com/search?q=${encodeURIComponent(u)}`;
  }
  return `${local ? "http" : "https"}://${u}`;
}
