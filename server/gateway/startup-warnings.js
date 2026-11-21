// The warnings the gateway prints at start when its configuration is weaker than production expects. Pure: env in, lines out —
// index.js logs them next to the listen line. Guard: startup-warnings.test.js.
//   GW_RUNTIME empty          user containers run as plain Docker containers: no Sysbox, so weaker isolation and no project
//                             containers (those need the inner dockerd that only sysbox-runc gives without --privileged).
//   GW_HOST not loopback and  the gateway is reachable from outside but sets its session cookie without the Secure flag — behind TLS
//   GW_SECURE != "1"          termination GW_SECURE=1 belongs in the unit.

/** True for addresses only this machine can reach (127.0.0.0/8, ::1, localhost, IPv4-mapped loopback). */
export function isLoopbackHost(host) {
  const h = String(host ?? "").trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  const v4 = h.startsWith("::ffff:") ? h.slice(7) : h;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/** The warning lines for this environment (empty when the configuration is the production one). Defaults as in index.js. */
export function startupWarnings(env = process.env) {
  const out = [];
  const runtime = String(env.GW_RUNTIME || "").trim();
  const host = env.GW_HOST || "127.0.0.1";
  if (!runtime) {
    out.push("[gateway] WARNING: GW_RUNTIME is empty — user containers run as plain Docker containers without Sysbox "
      + "(weaker isolation, no project containers). Set GW_RUNTIME=sysbox-runc for production.");
  }
  if (!isLoopbackHost(host) && env.GW_SECURE !== "1") {
    out.push(`[gateway] WARNING: GW_HOST=${host} is not a loopback address and GW_SECURE is not "1" — session cookies are sent `
      + "without the Secure flag. Set GW_SECURE=1 behind TLS.");
  }
  return out;
}
