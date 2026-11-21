# Layout fixtures (`layout-plan/`)

ONE fixture set for the three computations of a project's layout (the split into code repos and services):

| Computation | Test |
|---|---|
| Web `web/src/lib/project-layout.ts` | `web/test/project-layout-plan.test.mjs` |
| iOS `mobile/CbaseMobile/Code/ProjectLayout.swift` | `web/test/layout-ios-binding.test.mjs` (macOS only, `onlyMacOS` in the guard register) |
| Server `projectbox/layout/plan.js` | `server/backend/test/layout-plan.test.js` |

If two of them computed differently, an uploaded file would silently land somewhere other than the preview showed, or go missing.

## Shape of a case

```json
{
  "name": "longest-prefix",            // = file name without .json
  "description": "…",
  "mode": "creation" | "inventory",
  "selection": [ { "seq", "kind": "folder"|"files", "name", "files": [ { "rel", "size" } ] } ],  // creation: treeFromSelection
  "gitFiles": { "<seq>:<origin>": "gitdir: …" },                                                  // content of every .git FILE
  "tree": [ { "path", "kind", "codeRepo"? } ],                                                   // inventory: instead of selection
  "steps": [ { "kind": "move", "from", "to" } | { "kind": "omit"|"code-repo"|"code-repo-off", "path" } ],
  "expected": {
    "tree", "hints", "omitted", "upload",                      // only with selection
    "finalTree", "mapping", "finalMapping", "codeRepos", "repos", "error", "warnings",
    "targets": [ { "source", "origin", "target"? } ]           // targetOf; without "target" = covered by no entry (undefined)
  }
}
```

`_rules.json` holds the rules of all cases — exactly `GET /api/projectCreation/rules` without `reserveBytes`
(`projectbox/setup/rules.js` `rulesResponse()`); the web test keeps the two equal.

## Required cases

Longest prefix (`longest-prefix`), a child of a moved parent folder (`child-from-moved-parent-folder`), leaving out inside a parent
(`leave-out-in-parent`), a swap (`swap`; inventory: `inventory-swap-and-subtree`), a repo in a repo (`repo-in-repo`), the 26th repo
(`repo-locations-and-26-repos`). Also: default and omission (`creation-default`), equal names from two sources with parent link
(`same-names`), `.git` files (`git-files`), invalid steps and name rules (`steps-and-names`), final mapping of an inventory
(`inventory-final-mapping`), a name with control characters INSIDE a code repo stays out with a hint instead of failing the
whole upload at the server (`names-in-block`), an empty folder in a creation becomes no code repo and warns (`folder-empty`), and a
clone is ONE block without files — default name with suffix, name and location changeable, nothing to move into it
(`clone-name-and-location`; selection `kind: "clone"` with an empty file list).

## Changing or adding a case

Expectations are NOT copied from the computation without reading them: whoever writes a case works out every line of the
expectation by hand (which node goes where, which mapping entry, why this error) — a fixture that only mirrors what the code does
pins nothing. A case whose expectation changes through an intended change of the computation is brought along and run against ALL
three computations.
