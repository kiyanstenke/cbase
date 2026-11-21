// Seam gateway <-> backend at the schedule wakeup. The gateway wakes a sleeping container two minutes before the earliest occurrence
// it last read from server/gateway/containers.js SCHEDULED_OCCURRENCE_PATH; the path is answered by scheduled/routes.js
// scheduleNextRoute. If the two drift apart (one side renamed), the gateway would read "no occurrence" (a 404 is just an outage for it:
// null, the old value stays), and no scheduled job would fire in a sleeping container. Nobody would notice: the reaper is off in operation.
//
// The REAL backend from the agent harness is asked through the REAL gateway reader (server/gateway/proxy.js fetchJsonFromBackend, with the
// deadlines and caps from containers.js), without a session, and the result is computed as in containers.js nextScheduleOccurrence
// (`Number(nextAt) || 0`).
//
// Counter-test: bend SCHEDULED_OCCURRENCE_PATH in containers.js to another path => (1) red with "status 404".

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { withAgentsServer } from "./agent-harness.mjs";
import * as store from "../electron/server/store.js";
import { nextOccurrence, cadenceOff } from "../electron/server/scheduled/cadence.js";
import { BACKEND_QUESTION_DEADLINE_MS, SCHEDULED_OCCURRENCE_PATH, OCCURRENCE_CAP_BYTES } from "../../../server/gateway/containers.js";
import { fetchJsonFromBackend } from "../../../server/gateway/proxy.js";

// As the gateway does it: the reader, the deadlines, the arithmetic.
async function occurrenceAsTheGateway(port) {
  const r = await fetchJsonFromBackend(port, SCHEDULED_OCCURRENCE_PATH, { deadlineMs: BACKEND_QUESTION_DEADLINE_MS, capBytes: OCCURRENCE_CAP_BYTES });
  assert.ok(!r.error, `the gateway reads no occurrence under ${SCHEDULED_OCCURRENCE_PATH}: ${r.error}`);
  return Number(r.json?.nextAt) || 0;
}

test("the gateway reads the occurrence of the created job under SCHEDULED_OCCURRENCE_PATH; without a job 0", async () => {
  await withAgentsServer(async ({ port, chat }) => {
    assert.equal(await occurrenceAsTheGateway(port), 0, "without a job no occurrence (0, not null)");

    const r = cadenceOff("daily", { clockTime: "22:00" }, { timeZone: "Europe/Berlin" });
    assert.ok(r.ok, JSON.stringify(r));
    const now = Date.now();
    const raw = { id: crypto.randomUUID(), workspaceId: chat.workspaceId, instructions: "Enter the working hours.", cadence: "daily", plan: r.plan, cron: r.cron, oneTimeAt: r.oneTimeAt, timeZone: "Europe/Berlin", createdAt: now };
    const nextAt = nextOccurrence({ ...raw }, now);
    assert.ok(nextAt > now);
    store.createScheduledJob({ ...raw, nextAt });
    store.updateChat(chat.id, { jobId: raw.id, title: "Working hours", titled: 1 });

    assert.equal(await occurrenceAsTheGateway(port), nextAt, "the wakeup sees exactly the job's occurrence");
  });
});
