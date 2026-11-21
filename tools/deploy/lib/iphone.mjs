// Which iPhone accepts an installation NOW? — ONE calculation for the pre-check of `mobile --device`
// (targets/mobile.mjs) and the "connected devices" row in `status`. `mobile/make-ipa.command` recomputes the same
// rule in sh (comment there).
//
// Three measurements stand behind the rule:
//
//  · The JSON output is read, NOT the table. For a plugged-in, unlocked iPhone the table writes `available (paired)` in
//    its "State" column — the word "connected" does not appear in it at all. A text search for it took a cable-connected
//    iPhone (tunnel open, Developer Mode on) for "not connected" and refused the deploy. Decisive is
//    `connectionProperties.tunnelState`: only with "connected" does the device accept an installation right away.
//  · The tunnel FALLS ASLEEP as soon as nobody talks to the device: `list devices` reported `wired` + `disconnected` for
//    the plugged-in, unlocked iPhone three times in a row, while `device info details` built the same tunnel within a
//    second and returned `connected` (and `list devices` five seconds later as well). So wake first, then count; the
//    answer of the wake query is the verdict at the same time.
//  · An iPhone paired over Wi-Fi appears in the list as `transportType: "localNetwork"`, `tunnelState: "disconnected"`,
//    `pairingState: "paired"` (table: `available (paired)`); `device info details` wakes it just the same and reports
//    `connected`. An iPad out of reach appears as `tunnelState: "unavailable"` (without `transportType`) — it does not
//    count and is not woken.
//
// The rule: (1) if a UDID is configured, it is woken, and its answer judges; (2) otherwise — or with `all` in addition —
// the JSON list: `connected` counts, a PAIRED device with `disconnected` is woken via `device info details` and counts if
// it then reports `connected`; `unavailable` never counts. A UDID is woken at most ONCE. No JSON (old devicectl version,
// abort) ⇒ fall back to the table, word search `connected` (which does not hit "disconnected").
//
// `xcrun` is injectable (test: iphone.test.mjs): `(args) => Promise<{code, stdout}>`. For real, `xcrunCaller` builds it
// — with DEVELOPER_DIR (without it `xcrun` takes the CommandLineTools, which lack `devicectl`, and a plugged-in iPhone
// would look like none) and as root in the user context: CoreDevice is as user-specific as Xcode's accounts, as root the
// same cable device can report `disconnected` while the desktop user already has a connected tunnel.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TRANSPORT = { wired: "cable", localNetwork: "Wi-Fi" };

/** "iPhone of Maintainer (Wi-Fi)" / "(cable)" — unknown transport as "(?)". */
export function deviceText(g) {
  return `${g.name} (${TRANSPORT[g.transport] || g.transport || "?"})`;
}

/** The real caller: DEVELOPER_DIR always, `sudo -u <user>` if the process is not the desktop user. */
export function xcrunCaller({ probe, user, needSudo, developerDir, timeout = 60000 }) {
  return (args) =>
    needSudo
      ? probe("sudo", ["-u", user, "-H", "env", `DEVELOPER_DIR=${developerDir}`, "xcrun", ...args], { timeout })
      : probe("xcrun", args, { timeout, env: { ...process.env, DEVELOPER_DIR: developerDir } });
}

let counter = 0;

// devicectl writes the JSON itself — as the desktop user if we are root. Hence a file directly in the temp
// folder (under sudo: /tmp) and no mkdtemp: its 0700 folder would belong to root, and the user could not write into it.
async function jsonCall(xcrun, args, tmpDir) {
  const file = path.join(tmpDir, `cbase-devicectl-${process.pid}-${++counter}.json`);
  let r = { code: 1, stdout: "" };
  try {
    r = await xcrun([...args, "--json-output", file]);
    return { json: JSON.parse(fs.readFileSync(file, "utf8")), stdout: r?.stdout || "" };
  } catch {
    return { json: null, stdout: r?.stdout || "" };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function fromEntry(x, fallbackUdid, woken) {
  return {
    name: x?.deviceProperties?.name || "iPhone",
    udid: x?.hardwareProperties?.udid || fallbackUdid || x?.identifier || null,
    transport: x?.connectionProperties?.transportType || null,
    woken,
  };
}

const tunnel = (x) => x?.connectionProperties?.tunnelState;

/**
 * The connected (or successfully woken) devices.
 * `source`: "udid" (the wake query judged, list not read), "list" (JSON), "text" (fallback).
 * @returns {Promise<{devices: Array<{name, udid, transport, woken, text}>, source: "udid"|"list"|"text"}>}
 */
export async function findIphones({ xcrun, udid = "", all = false, tmpDir = os.tmpdir() }) {
  const devices = [];
  const attempted = new Set();
  const alongside = (g) => {
    if (devices.some((h) => (g.udid ? h.udid === g.udid : h.name === g.name))) return;
    devices.push({ ...g, text: deviceText(g) });
  };

  // (1) Wake the configured UDID — its answer is the verdict.
  if (udid) {
    attempted.add(udid);
    const { json } = await jsonCall(xcrun, ["devicectl", "device", "info", "details", "--device", udid], tmpDir);
    const r = json?.result;
    if (tunnel(r) === "connected") {
      alongside(fromEntry(r, udid, true));
      if (!all) return { devices, source: "udid" };
    }
  }

  // (2) The list: connected counts, paired-asleep is woken, unavailable never.
  const { json, stdout } = await jsonCall(xcrun, ["devicectl", "list", "devices"], tmpDir);
  const list = json?.result?.devices;
  if (!Array.isArray(list)) {
    // No JSON: fall back to the table instead of failing here. First column = name.
    for (const l of String(stdout).split("\n")) {
      if (/\bconnected\b/i.test(l)) alongside({ name: l.trim().split(/\s{2,}/)[0], udid: null, transport: null, woken: false });
    }
    return { devices, source: "text" };
  }
  for (const x of list) {
    const id = x?.hardwareProperties?.udid || x?.identifier;
    if (tunnel(x) === "connected") {
      alongside(fromEntry(x, id, false));
      continue;
    }
    if (tunnel(x) !== "disconnected" || x?.connectionProperties?.pairingState !== "paired") continue;
    if (!id || attempted.has(id) || (x?.identifier && attempted.has(x.identifier))) continue;
    attempted.add(id);
    const { json: d } = await jsonCall(xcrun, ["devicectl", "device", "info", "details", "--device", id], tmpDir);
    if (tunnel(d?.result) === "connected") alongside(fromEntry(d.result, id, true));
  }
  return { devices, source: "list" };
}
