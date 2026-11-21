import assert from "node:assert/strict";
import test from "node:test";
import { aggregateContainerStats } from "../electron/server/services.js";

test("shared Docker RAM capacity is counted once across containers", () => {
  const sharedLimit = 15.51 * 1024 ** 3;
  const rows = Array.from({ length: 11 }, (_, i) => ({
    cpu: i === 0 ? 10 : 0,
    memBytes: 120 * 1024 ** 2,
    memLimitBytes: sharedLimit,
  }));

  const result = aggregateContainerStats(rows);

  assert.equal(result.containers, 11);
  assert.equal(result.cpu, 10);
  assert.equal(result.memBytes, 1320 * 1024 ** 2);
  assert.equal(result.memLimitBytes, sharedLimit);
});
