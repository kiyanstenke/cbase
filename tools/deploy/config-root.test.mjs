// The installation configuration (config.mjs) re-exports the repository root of the leaf the gate uses (tools/check/config-repo.mjs):
// there is ONE root, and the private part never computes its own.
import test from "node:test";
import assert from "node:assert/strict";
import { REPO } from "../check/config-repo.mjs";
import * as full from "./config.mjs";

test("config.mjs re-exports the same root", () => {
  assert.equal(full.REPO, REPO);
});
