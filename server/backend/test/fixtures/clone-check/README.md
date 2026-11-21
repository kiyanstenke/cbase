# clone-check — ONE rule for a clone address, three places

The address of a git repository as the source of a project creation is checked by three computations: the web client
(`web/src/lib/project-clone.ts` `checkClone`), iOS (`mobile/CbaseMobile/Code/ProjectClone.swift` `ProjectClone.check`) and the
server (`server/backend/electron/server/projectbox/setup/clone.js` `checkCloneDetail`, the boundary — 400 before any creation). If
they drift, an address passes in the client and only fails after "Create", or an IDN host is looked up and stored in its Unicode
form on iOS.

`cases.json`: per case `url`, `branch`, the expectation of the CLIENT (`{ host, name }` or `{ code }` — web and iOS alike) and of
the SERVER (`{ host }` or `{ code }`). The codes differ in only two places: an empty address is `EMPTY` in the client but
`ONLY_HTTPS` at the server; the client says `INVALID` for a form without `//` (server `ONLY_HTTPS`) and for an address without a
usable name (server `HOST_UNCLEAR`, "names no repository").

Guarded by `web/test/project-clone-check.test.mjs` (web), `web/test/clone-ios-binding.test.mjs` (Swift via `xcrun swift`, macOS
only) and `server/backend/test/clone-check.test.js` (server). A new case belongs HERE, not in one of the three tests.
