// The API level of the HTTP API (`/api`, `/gw`) that the iOS app and third-party clients use — the ONE place in the server, PURE
// (constants only). The policy is VERSIONING.md, "API level": `level` is the newest level this server speaks, `oldest` the oldest
// it still serves.
//   · adding a route or an optional field raises nothing;
//   · removing or renaming a route or field, or making a field required, raises `level`;
//   · switching an old level off raises `oldest` — no earlier than DEPRECATION_WINDOW_DAYS after an app speaking the new level is
//     in the store, and only after a "Deprecated" entry in an earlier release.
// Level 1 is exactly what the iOS app 0.2.0 uses (frozen). A client that sends no `X-Cbase-Client` header counts as level 1.
//
// The gateway carries a copy of these two numbers (it is rolled out on its own and cannot import the backend): `API_LEVEL` in
// server/gateway/build-info.js, bound to this module by server/gateway/build-info.test.js. Raising a number here means rolling out
// the gateway too (`./deploy server --gateway`).

export const API_LEVEL = Object.freeze({ level: 1, oldest: 1 });

/** Days between an app with the new level in the store and the earliest switch-off of the old level (`oldest` + 1). */
export const DEPRECATION_WINDOW_DAYS = 90;
