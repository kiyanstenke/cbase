// The links of a VS Code Remote Tunnel: vscode.dev in the browser and the desktop via the vscode:// scheme, remote authority
// `tunnel+<name>`. The path is the container path of the workspace (/home/agent/workspaces/…) — encoded segment by segment so a
// space in the name does not tear the link, while the slashes stay.
export type TunnelPhase = "off" | "login" | "starts" | "connected" | "error";

export function tunnelPath(path: string): string {
  const p = String(path || "").replace(/\\/g, "/");
  return (p.startsWith("/") ? "" : "/") + p.split("/").map((s) => encodeURIComponent(s)).join("/");
}

export function tunnelLinks(name: string, path: string): { browser: string; desktop: string } {
  const n = encodeURIComponent(String(name || "").trim().toLowerCase());
  const p = tunnelPath(path);
  return { browser: `https://vscode.dev/tunnel/${n}${p}`, desktop: `vscode://vscode-remote/tunnel+${n}${p}` };
}

// A window INSIDE the project container — Dev Containers "attach" behind the tunnel. The extension runs on the Mac (extensionKind ui)
// and calls docker via the tunnel's exec server in the user container; vscode.dev cannot do that
// (microsoft/vscode-remote-release#9059), hence only the desktop link. Authority
// `attached-container+<HEX>@tunnel+<name>`, HEX = base-16-encoded UTF-8 of `{<container-name field>:"/<name>","settings":{"context":
// "default"}}` — the leading slash as in `docker inspect`, `context` against a DOCKER_HOST on the Mac. The form is held by
// web/test/vscode-container-link.test.mjs against the extension's parser regex. Without tunnel name or container: null.
// What the link does NOT override: a local `dev.containers.dockerPath` (in the extension `scope: "application"`) applies behind the
// tunnel too — Dev Containers then calls the Mac path in the user container, `inspect` fails, and VS Code reports
// "Cannot attach … it no longer exists" although the container is running.
export function containerLink(name: string, container: string, path: string): string | null {
  const n = String(name || "").trim().toLowerCase();
  const c = String(container || "").trim();
  if (!n || !c) return null;
  const json = JSON.stringify({ containerName: `/${c}`, settings: { context: "default" } });
  const hex = Array.from(new TextEncoder().encode(json), (b) => b.toString(16).padStart(2, "0")).join("");
  return `vscode://vscode-remote/attached-container+${hex}@tunnel+${encodeURIComponent(n)}${tunnelPath(path)}`;
}

// The same rule as in the backend (vscode-tunnel.js) — the pill shows the error before the server returns it.
export const tunnelNameValid = (x: string) => /^[a-z0-9][a-z0-9-]{0,19}$/.test(String(x || "").trim().toLowerCase());
