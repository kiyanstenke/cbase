// A workspace's time zone: the one a client chose last (key `timeZone.<wid>`, default UTC — the container itself
// runs in UTC). A leaf that imports only the store and cron.js.
// Readers: outerloop/trigger.js (clock times), outerloop/input.js and communication/retrieval.js (wall time in text),
// channels/delivery.js (clock time of a channel message).
// Writers: whoever creates or changes a schedule with a zone (rememberTimeZone). Deletion: store/workspaces.js
// (every setting ending in `.<wid>` goes with the workspace).

import * as store from "../store.js";
import { zoneValid } from "../cron.js";

export const timeZoneKey = (wid) => `timeZone.${wid}`;
/** A workspace's zone; "UTC" without a choice. */
export const timeZoneDefault = (wid) => store.getSetting(timeZoneKey(wid), "UTC");
/** Remembers the zone when it is valid (an invalid one is silently skipped). */
export const rememberTimeZone = (wid, tz) => { if (zoneValid(tz)) store.setSetting(timeZoneKey(wid), tz); };
