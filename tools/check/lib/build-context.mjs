// The files of server/backend/ that go into the server build context: one product list (server/backend/build-context-files.json,
// next to build.sh), read here for the upload loop of targets/server.mjs. server/backend/test/build-context.test.js binds the same
// list to the `cp` lines of build.sh.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const FILE = fileURLToPath(new URL("../../../server/backend/build-context-files.json", import.meta.url));

export const BUILD_CONTEXT_FILES = JSON.parse(fs.readFileSync(FILE, "utf8")).files;
