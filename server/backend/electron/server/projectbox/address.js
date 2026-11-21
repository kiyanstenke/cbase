// Host:port of an instance. A leaf without imports — so the leaves browsers.js and debug.js may load it too (they get the instance as
// an object, never the store).
//
// hostPort(host, port)  "host:port" — an IPv6 address in square brackets ("[::1]:7718"). All product code that assembles the address of
//   a project container into a connection or URL goes through here: the instance IP is an IPv4 of the project network on the server, but
//   in the test the second loopback address (fake-docker.mjs `secondLoopback`), and that is `::1` on macOS — a hand-built
//   `${ip}:${port}` would give "::1:7718" there, another address without a port. Already bracketed stays as it is. A port outside
//   0…65535 or not an integer throws (no silent ":NaN").
export function hostPort(host, port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 0 || p > 65535) throw new TypeError(`hostPort: not a port: ${port}`);
  const h = String(host || "");
  if (!h) throw new TypeError("hostPort: no host");
  const v6 = h.includes(":") && !h.startsWith("[");
  return `${v6 ? `[${h}]` : h}:${p}`;
}

// instanceIp(inst)  the IP of an instance through which B reaches its services (CDP of the browsers, inspector) — THROWS without it: an
//   instance without an IP is "unknown", not "127.0.0.1" (empty is not unknown). A fallback to the loopback of B would hit a service of
//   B at the same port instead of the project.
export function instanceIp(inst) {
  const ip = String(inst?.ip || "");
  if (!ip) throw new Error(`Instance ${inst?.identifier || inst?.projectId || "?"} without an IP — its services cannot be addressed from B`);
  return ip;
}

// urlWithHost(url, host)  the same URL (ws://, http://) with `host` in place of its host, the port stays. For the address that a
//   process IN the project container reports about itself — Chromium "DevTools listening on ws://127.0.0.1:<p>/…", Node "Debugger
//   listening on ws://127.0.0.1:<p>/…": there 127.0.0.1 is the loopback of the container, B reaches it via the IP of the instance
//   (DNAT on eth0). The address goes through hostPort (IPv6 in brackets).
export function urlWithHost(url, host) {
  const u = new URL(String(url));
  const standard = u.protocol === "wss:" || u.protocol === "https:" ? 443 : 80;
  u.host = hostPort(host, u.port || standard);
  return u.href;
}
