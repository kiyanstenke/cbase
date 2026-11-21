// The two deadlines of the ops status, in a leaf without imports so that an operator's status tool can read the
// curl deadline without loading the backend. Used by ./compose-in-b.js (re-exported there); guard:
// server/backend/test/compose-in-b.test.js.

// The cap of the `ps` in B: short, below the deadline of the reader.
export const COMPOSE_IN_B_CAP_MS = 3_000;
// `curl --max-time` (seconds) with which an operator's status tool reads GET /api/projectbox/ops-status.
export const OPS_STATUS_CURL_MAX_TIME_S = 5;
