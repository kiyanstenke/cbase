// The line splitter of the iOS stream readers (mobile/CbaseMobile/Models/SSERows.swift), EXECUTED with `xcrun swift`
// and held against the SSE specification rule the browser follows too: lines end at LF, CR or CRLF, nowhere else.
//
// Why: `URLSession.AsyncBytes.lines` also splits at U+2028, U+2029, U+0085 (and VT/FF) and drops empty lines.
// `JSON.stringify` leaves the first three raw, so an event whose text carried one was torn apart: `namedStream` dropped it
// silently, `stream` ended the whole stream with a decode error. The "raw U+2028 in JSON" case therefore ALSO runs through
// `.lines` here, as proof that the input hits the old fault (if it no longer tears there, Apple changed the behaviour and the
// header of SSERows.swift is out of date).
//
// By path: both readers in APIClient.swift read via `bytes.sseLines`, and the app code has no `.lines` left (comments aside).
//
// Counter-test: turning `case 0x0D` in the splitter to "append" AND `namedStream` back to `bytes.lines` turns "CRLF",
// "CR alone", "CR CR LF", "separators only" and the path binding red.
//
// macOS only (latch.json `onlyMacOS`). Run:  node --test web/test/sse-rows-ios.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const SOURCE = path.join(repo, "mobile", "CbaseMobile", "Models", "SSERows.swift");
const API = path.join(repo, "mobile", "CbaseMobile", "Models", "APIClient.swift");

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const NEL = String.fromCharCode(0x85);
const VT = String.fromCharCode(0x0b);
const FF = String.fromCharCode(0x0c);

// The cases: name and text (passed as UTF-8).
const CASES = [
  ["heartbeat with blank line", "event: ping\ndata: {}\n\n"],
  ["raw U+2028/U+2029/U+0085 in JSON", `id: 3\ndata: {"d":"A${LS}B${PS}C${NEL}D","bis":3}\n\n`],
  ["VT and FF do not split", `data: a${VT}b${FF}c\n`],
  ["CRLF", "a\r\nb\r\n"],
  ["CR alone", "a\rb\r"],
  ["CR CR LF", "a\r\r\nb\n"],
  ["unfinished trailing line is dropped", "a\nb"],
  ["multi-byte characters", "data: ü😀\n"],
  ["separators only", "\n\n\r\n"],
];

/** The SSE specification rule (and the browser's): lines end at CRLF, LF or CR; anything after without an ending is dropped. */
function sseLines(text) {
  const parts = text.split(/\r\n|\r|\n/);
  parts.pop();
  return parts;
}

let run = null;
function swiftRun() {
  if (run) return run;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cbase-sse-rows-"));
  const file = path.join(tmp, "rows.swift");
  const bytes = CASES.map(([, t]) => `[${[...Buffer.from(t, "utf8")].join(", ")}]`).join(",\n    ");
  const program = `${fs.readFileSync(SOURCE, "utf8")}

struct TestBytes: AsyncSequence {
    typealias Element = UInt8
    let d: [UInt8]
    struct AsyncIterator: AsyncIteratorProtocol {
        var i = 0
        let d: [UInt8]
        mutating func next() async -> UInt8? { guard i < d.count else { return nil }; defer { i += 1 }; return d[i] }
    }
    func makeAsyncIterator() -> AsyncIterator { AsyncIterator(d: d) }
}

let cases: [[UInt8]] = [
    ${bytes}
]
let finished = DispatchSemaphore(value: 0)
Task {
    do {
        var separator: [[String]] = []
        var adapter: [[String]] = []
        var old: [[String]] = []
        for f in cases {
            var t = SSELineSeparator()
            separator.append(f.compactMap { t.take($0) })
            var a: [String] = []
            for try await z in TestBytes(d: f).sseLines { a.append(z) }
            adapter.append(a)
            var l: [String] = []
            for try await z in TestBytes(d: f).lines { l.append(z) }
            old.append(l)
        }
        let json = try JSONSerialization.data(withJSONObject: ["separator": separator, "adapter": adapter, "old": old])
        print(String(decoding: json, as: UTF8.self))
    } catch {
        print("ERROR \\(error)")
    }
    finished.signal()
}
finished.wait()
`;
  fs.writeFileSync(file, program);
  let output;
  try {
    output = execFileSync("xcrun", ["swift", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    assert.fail(`SSERows.swift could not be executed (xcrun swift): ${e.stderr || e.message}`);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  run = JSON.parse(output.trim().split("\n").at(-1));
  return run;
}

CASES.forEach(([name, text], i) => {
  test(`SSE rows: ${name} — splitter and AsyncSequence follow the specification`, () => {
    const { separator, adapter } = swiftRun();
    assert.deepEqual(separator[i], sseLines(text), "SSELineSeparator");
    assert.deepEqual(adapter[i], sseLines(text), "bytes.sseRows");
  });
});

test("The input hits the old fault: `.lines` tears the line with U+2028 (proof that the case enters the path)", () => {
  const { old } = swiftRun();
  const i = CASES.findIndex(([n]) => n.startsWith("raw U+2028"));
  assert.ok(old[i].length > sseLines(CASES[i][1]).filter(Boolean).length,
    `AsyncBytes.lines no longer splits there: ${JSON.stringify(old[i])} — then update the header of SSERows.swift`);
});

test("APIClient reads both streams via bytes.sseLines; no `.lines` left in the app code", () => {
  const api = fs.readFileSync(API, "utf8");
  assert.equal((api.match(/for try await line in bytes\.sseLines \{/g) || []).length, 2, "stream and namedStream do not both read via sseLines");
  const hits = [];
  const run = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { run(p); continue; }
      if (!e.name.endsWith(".swift")) continue;
      fs.readFileSync(p, "utf8").split("\n").forEach((z, n) => {
        const code = z.replace(/\/\/.*$/, "");
        if (/\.lines\b/.test(code)) hits.push(`${path.relative(repo, p)}:${n + 1}`);
      });
    }
  };
  run(path.join(repo, "mobile", "CbaseMobile"));
  assert.deepEqual(hits, [], `\`.lines\` in code: ${hits.join(", ")}`);
});
