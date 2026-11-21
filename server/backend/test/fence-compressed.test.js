// Guard "fence × compression". `send` (runtime/http.js) compresses JSON from COMPRESS_FROM_CHARACTERS on according to
// `Accept-Encoding`. The filter of a "filtered" row (projectbox/fence.js:filterResponse) collected those bytes and parsed them
// raw: cbase_service_start, cbase_service_log and cbase_ports_list answered only "Fence: the response could not be filtered
// (Unexpected token '\u001f' … is not valid JSON)".
//
// Promises:
//   (1) A filtered response above the threshold arrives filtered with gzip, br and without Accept-Encoding (200, marker), as
//       PLAIN TEXT: without Content-Encoding, without Vary — the encoding belonged to the unfiltered body.
//   (2) The filter still works: the foreign entries are gone.
//   (3) An unknown encoding does not go out (403) instead of slipping through raw.
// Counter-test against the state before the fix: (1) red with 403 "… is not valid JSON" for gzip and br, (3) red (no export).
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import zlib from "node:zlib";

import { FILTER, FENCED_HEADER, decodedBody, filterResponse } from "../electron/server/projectbox/fence.js";
import { COMPRESS_FROM_CHARACTERS, send } from "../electron/server/runtime/http.js";

const OWN = "p-own";
// Well above the threshold: many services, most of them from a foreign project.
const SERVICES = Array.from({ length: 400 }, (_, i) => ({
  id: `d${i}`, projectId: i % 10 === 0 ? OWN : "p-foreign", name: `Service ${i} ${"x".repeat(60)}`, port: 3000 + i,
}));

function withServer(respond, fn) {
  const server = http.createServer(respond);
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", async () => {
      try { resolve(await fn(server.address().port)); } catch (e) { reject(e); } finally { server.closeAllConnections?.(); server.close(); }
    });
  });
}

function fetchRaw(port, header) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/services", headers: header }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode, header: res.headers, body: Buffer.concat(parts) }));
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

test("(1)(2) filtered response above the threshold: gzip, br, none — filtered, plain text, without Content-Encoding", async () => {
  assert.ok(JSON.stringify(SERVICES).length > COMPRESS_FROM_CHARACTERS, "the sample lies above the threshold");
  await withServer((req, res) => {
    filterResponse(res, FILTER.services, { P: OWN });
    send(res, 200, SERVICES);
  }, async (port) => {
    for (const ae of ["gzip, deflate, br", "gzip", "br", ""]) {
      const label = ae || "none";
      const r = await fetchRaw(port, ae ? { "Accept-Encoding": ae } : {});
      assert.equal(r.status, 200, `${label}: ${r.body.toString("utf8").slice(0, 200)}`);
      assert.equal(r.header[FENCED_HEADER], "1", `${label}: marker`);
      assert.equal(r.header["content-encoding"], undefined, `${label}: no Content-Encoding on plain text`);
      assert.equal(r.header.vary, undefined, `${label}: no Vary`);
      const list = JSON.parse(r.body.toString("utf8"));
      assert.equal(list.length, 40, `${label}: only the own entries`);
      assert.ok(list.every((d) => d.projectId === OWN), `${label}: nothing foreign`);
    }
  });
});

test("(3) unknown encoding: 403, nothing goes out; the list is decoded backwards", async () => {
  const plain = Buffer.from(JSON.stringify({ a: 1 }));
  assert.deepEqual(JSON.parse(decodedBody(zlib.brotliCompressSync(zlib.gzipSync(plain)), "gzip, br").toString()), { a: 1 });
  assert.deepEqual(JSON.parse(decodedBody(plain, "identity").toString()), { a: 1 });
  assert.throws(() => decodedBody(plain, "zstd"), /unknown encoding/);
  await withServer((req, res) => {
    filterResponse(res, FILTER.services, { P: OWN });
    res.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "zstd" });
    res.end(JSON.stringify(SERVICES));
  }, async (port) => {
    const r = await fetchRaw(port, {});
    assert.equal(r.status, 403);
    assert.match(JSON.parse(r.body.toString("utf8")).error, /could not be filtered \(unknown encoding "zstd"\)/);
    assert.ok(!r.body.toString("utf8").includes("p-foreign"), "nothing foreign in the error");
  });
});
