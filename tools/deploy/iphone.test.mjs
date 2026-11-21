// Which iPhone accepts an installation (lib/iphone.mjs), against a FAKE xcrun that writes the JSON responses devicectl really
// gave on this Mac.
//
// The case that justifies this test is the WIFI iPhone: `list devices` reports it as `localNetwork` + `disconnected`, the
// table as `available (paired)`; `status` and `make-ipa.command` searched the table for "connected" and never saw it. The
// counter-test (the old text search on the same table) stands next to it as a test of its own.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { findIphones, deviceText } from "./lib/iphone.mjs";

const IPHONE = "00008150-0000000000000A11";
const IPAD = "00008132-0000000000000A12";

// The table, verbatim: the word "connected" appears nowhere.
const TABLE = [
  "Name               Hostname                            Identifier                             State                Model                           ",
  "----------------   ---------------------------------   ------------------------------------   ------------------   --------------------------------",
  "iPad of Maintainer     iPad-of-Maintainer.coredevice.local     E8859686-A0D2-547E-B001-960AA6E8EAF4   unavailable          iPad Pro 13-inch (M4) (iPad16,5)",
  "iPhone of Maintainer   iPhone-of-Maintainer.coredevice.local   5C9DBF48-F41F-519B-8EAB-078255114399   available (paired)   iPhone 17 (iPhone18,3)          ",
].join("\n");

// The fields of the real answers that the computation reads, values taken verbatim.
function iphone(conn) {
  return {
    identifier: "5C9DBF48-F41F-519B-8EAB-078255114399",
    connectionProperties: {
      authenticationType: "manualPairing",
      isMobileDeviceOnly: false,
      pairingState: "paired",
      tunnelTransportProtocol: "tcp",
      ...conn,
    },
    deviceProperties: { name: "iPhone of Maintainer", osVersionNumber: "26.6.2", developerModeStatus: "enabled" },
    hardwareProperties: { udid: IPHONE, deviceType: "iPhone", platform: "iOS" },
  };
}
const IPAD_ENTRY = {
  identifier: "E8859686-A0D2-547E-B001-960AA6E8EAF4",
  connectionProperties: { authenticationType: "manualPairing", isMobileDeviceOnly: false, pairingState: "paired", tunnelState: "unavailable" },
  deviceProperties: { name: "iPad of Maintainer", osVersionNumber: "26.6.1", developerModeStatus: "disabled" },
  hardwareProperties: { udid: IPAD, deviceType: "iPad", platform: "iOS" },
};
const WIFI_SLEEPS = iphone({ transportType: "localNetwork", tunnelState: "disconnected" });
const WIFI_AWAKE = iphone({ transportType: "localNetwork", tunnelState: "connected", tunnelIPAddress: "fdf3:2ad7:b781::1" });
const CABLE_AWAKE = iphone({ transportType: "wired", tunnelState: "connected" });
const CABLE_SLEEPS = iphone({ transportType: "wired", tunnelState: "disconnected" });

const envelope = (commandType, result) => ({ info: { commandType, jsonVersion: 3, outcome: "success", version: "518.33" }, result });
const list = (...devices) => envelope("devicectl.list.devices", { devices });
const details = (dev) => envelope("devicectl.device.info.details", dev);

/**
 * The fake xcrun: writes the answer to the file behind `--json-output` (like devicectl) and logs every call.
 * `responses.list` / `responses.details[udid]`: JSON object, `null` = no file (device unreachable, old version);
 * `stdout` = the table.
 */
function fakeXcrun(responses) {
  const calls = [];
  const xcrun = async (args) => {
    calls.push(args.slice(0, args.indexOf("--json-output")).join(" "));
    const file = args[args.indexOf("--json-output") + 1];
    let json = null;
    if (args[1] === "list") json = responses.list;
    else if (args[1] === "device") json = responses.details?.[args[args.indexOf("--device") + 1]] ?? null;
    if (json) fs.writeFileSync(file, JSON.stringify(json, null, 2));
    return { code: json ? 0 : 1, stdout: responses.stdout ?? TABLE, stderr: "" };
  };
  return { xcrun, calls };
}

function withTmp(fn) {
  return async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-iphone-test-"));
    try {
      await fn(tmpDir);
      assert.deepEqual(fs.readdirSync(tmpDir), [], "no JSON file may be left behind");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

test("deviceText: WIFI, cable, unknown", () => {
  assert.equal(deviceText({ name: "iPhone of Maintainer", transport: "localNetwork" }), "iPhone of Maintainer (Wi-Fi)");
  assert.equal(deviceText({ name: "iPhone of Maintainer", transport: "wired" }), "iPhone of Maintainer (cable)");
  assert.equal(deviceText({ name: "X", transport: null }), "X (?)");
});

test("cable, tunnel open: the UDID wake query decides, the list is not read", withTmp(async (tmpDir) => {
  const { xcrun, calls } = fakeXcrun({ details: { [IPHONE]: details(CABLE_AWAKE) }, list: list(CABLE_AWAKE, IPAD_ENTRY) });
  const r = await findIphones({ xcrun, udid: IPHONE, tmpDir });
  assert.deepEqual(r.devices.map((g) => g.text), ["iPhone of Maintainer (cable)"]);
  assert.equal(r.source, "udid");
  assert.deepEqual(calls, [`devicectl device info details --device ${IPHONE}`]);
}));

test("cable, tunnel open, without UDID: the list counts it without waking", withTmp(async (tmpDir) => {
  const { xcrun, calls } = fakeXcrun({ list: list(IPAD_ENTRY, CABLE_AWAKE) });
  const r = await findIphones({ xcrun, udid: "", tmpDir });
  assert.deepEqual(r.devices.map((g) => [g.text, g.udid, g.woken]), [["iPhone of Maintainer (cable)", IPHONE, false]]);
  assert.deepEqual(calls, ["devicectl list devices"]);
}));

test("WIFI, asleep, WITHOUT UDID: woken from the list => \"iPhone of Maintainer (Wi-Fi)\" (the reported case)", withTmp(async (tmpDir) => {
  const { xcrun, calls } = fakeXcrun({ list: list(IPAD_ENTRY, WIFI_SLEEPS), details: { [IPHONE]: details(WIFI_AWAKE) } });
  const r = await findIphones({ xcrun, udid: "", tmpDir });
  assert.deepEqual(r.devices.map((g) => [g.text, g.udid, g.transport, g.woken]), [["iPhone of Maintainer (Wi-Fi)", IPHONE, "localNetwork", true]]);
  assert.equal(r.source, "list");
  // The iPad (unavailable) is NOT woken.
  assert.deepEqual(calls, ["devicectl list devices", `devicectl device info details --device ${IPHONE}`]);
}));

test("WIFI, asleep, WITH UDID: the wake query alone suffices", withTmp(async (tmpDir) => {
  const { xcrun, calls } = fakeXcrun({ list: list(IPAD_ENTRY, WIFI_SLEEPS), details: { [IPHONE]: details(WIFI_AWAKE) } });
  const r = await findIphones({ xcrun, udid: IPHONE, tmpDir });
  assert.deepEqual(r.devices.map((g) => g.text), ["iPhone of Maintainer (Wi-Fi)"]);
  assert.deepEqual(calls, [`devicectl device info details --device ${IPHONE}`]);
}));

test("cable, asleep: woken => counts", withTmp(async (tmpDir) => {
  const { xcrun } = fakeXcrun({ list: list(CABLE_SLEEPS), details: { [IPHONE]: details(CABLE_AWAKE) } });
  const r = await findIphones({ xcrun, tmpDir });
  assert.deepEqual(r.devices.map((g) => g.text), ["iPhone of Maintainer (cable)"]);
}));

test("WLAN, waking fails (answer stays disconnected): no device, and the UDID is woken only ONCE", withTmp(async (tmpDir) => {
  const { xcrun, calls } = fakeXcrun({ list: list(IPAD_ENTRY, WIFI_SLEEPS), details: { [IPHONE]: details(WIFI_SLEEPS) } });
  const r = await findIphones({ xcrun, udid: IPHONE, tmpDir });
  assert.deepEqual(r.devices, []);
  assert.deepEqual(calls, [`devicectl device info details --device ${IPHONE}`, "devicectl list devices"]);
}));

test("WLAN, waking fails (no JSON file, device unreachable): no device", withTmp(async (tmpDir) => {
  const { xcrun, calls } = fakeXcrun({ list: list(WIFI_SLEEPS), details: { [IPHONE]: null } });
  const r = await findIphones({ xcrun, udid: "", tmpDir });
  assert.deepEqual(r.devices, []);
  assert.deepEqual(calls, ["devicectl list devices", `devicectl device info details --device ${IPHONE}`]);
}));

test("only unavailable: nothing counts, nothing is woken", withTmp(async (tmpDir) => {
  const { xcrun, calls } = fakeXcrun({ list: list(IPAD_ENTRY), details: { [IPAD]: details(IPAD_ENTRY) } });
  const r = await findIphones({ xcrun, udid: "", tmpDir });
  assert.deepEqual(r.devices, []);
  assert.deepEqual(calls, ["devicectl list devices"]);
}));

test("a PAIRED device wakes, an unpaired one does not", withTmp(async (tmpDir) => {
  const foreign = iphone({ transportType: "localNetwork", tunnelState: "disconnected", pairingState: "unpaired" });
  const { xcrun, calls } = fakeXcrun({ list: list(foreign), details: { [IPHONE]: details(WIFI_AWAKE) } });
  const r = await findIphones({ xcrun, tmpDir });
  assert.deepEqual(r.devices, []);
  assert.deepEqual(calls, ["devicectl list devices"]);
}));

test("all: the UDID decides AND the list is added, without duplicates and without a second wake", withTmp(async (tmpDir) => {
  const second = {
    ...CABLE_AWAKE,
    identifier: "11111111-2222-3333-4444-555555555555",
    deviceProperties: { name: "Test-iPhone" },
    hardwareProperties: { udid: "00008150-000000000000AAAA" },
  };
  const { xcrun, calls } = fakeXcrun({ list: list(WIFI_AWAKE, second, IPAD_ENTRY), details: { [IPHONE]: details(WIFI_AWAKE) } });
  const r = await findIphones({ xcrun, udid: IPHONE, all: true, tmpDir });
  assert.deepEqual(r.devices.map((g) => g.text), ["iPhone of Maintainer (Wi-Fi)", "Test-iPhone (cable)"]);
  assert.deepEqual(calls, [`devicectl device info details --device ${IPHONE}`, "devicectl list devices"]);
}));

test("no JSON (old devicectl version): fallback to the table, word search \"connected\"", withTmp(async (tmpDir) => {
  const alt = [
    "Name               Identifier                             State       Model",
    "iPhone of Maintainer   5C9DBF48-F41F-519B-8EAB-078255114399   connected   iPhone 17 (iPhone18,3)",
    "Altes iPhone       AAAAAAAA-A0D2-547E-B001-960AA6E8EAF4   disconnected   iPhone 12",
  ].join("\n");
  const { xcrun } = fakeXcrun({ list: null, stdout: alt });
  const r = await findIphones({ xcrun, udid: "", tmpDir });
  assert.equal(r.source, "text");
  // "disconnected" does NOT hit the word search (the old `status` search /connected/ would have counted it).
  assert.deepEqual(r.devices.map((g) => g.text), ["iPhone of Maintainer (?)"]);
}));

test("counter-test: the old text search from status.mjs/make-ipa.command does NOT see the WIFI iPhone", () => {
  const alt = TABLE.split("\n").filter((l) => /connected/i.test(l));
  assert.deepEqual(alt, [], "the table does not contain \"connected\" — exactly why it said \"none\" there");
});
