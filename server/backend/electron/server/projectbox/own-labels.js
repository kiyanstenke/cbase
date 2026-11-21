// The label keys that cbase ITSELF sets on its containers in the daemon of B. A leaf without a single import: the relocation
// (relocation/plan.js, relocation/collect.js, relocation/procedure.js), the clearing of the helpers (helper.js:removeHelper), the
// deletion of a project (erase.js:onlyOwn) and the deploy side (the deploy tool's gates.mjs:innerFrom) ask HERE whether a container is
// one of cbase — no second filter, certainly no prefix.
//
// THE REASON. The three places of the relocation used to skip every container that carried ANY label beginning with `cbase.`. A
// container inherits the labels of its image (`Config.Labels` = image labels ∪ own, the own win); an image with `LABEL cbase.probe=x`
// made db-1/files-1/spare-1 of a throwaway stack invisible: plan `canRelocate` with a single container, the volumes of the three
// "withoutContainer" although running containers had mounted them; a POST would have copied the volume of a running Postgres and left
// ten containers in B, and the re-read in step 4 did not see them either.
//
// THE RULE. A container is own exactly if it carries a key from OWN_LABELS that is set ON THE CONTAINER (`docker run --label`) — not
// one it inherited from its image. cbase never sets its labels on the image: the Dockerfile (server/backend/Dockerfile, stages basis →
// projectbox → backend) has no `LABEL` line with `cbase.`, the guard holds that. So a key does NOT count whose value equals the value
// of the same key in the image (whether it was set once more equally on the container, nobody sees; with cbase that never happens).
// If the image is unknown (`imageLabels` null: not read, no longer there), the key counts alone — a container of cbase must never be
// left out; that a foreign container excluded this way does not go missing SILENTLY is ensured by the relocation additionally (plan.js
// hold reason `container-excluded`, procedure.js `deviationsFromPlan`).
//
// WHO SETS WHAT (the list is the union; the guard server/backend/test/relocation-plan.test.js binds it to the constants):
//   cbase.project, cbase.instance, cbase.mounts   the project container (creation.js: LABEL_PROJECT, LABEL_INSTANCE, LABEL_MOUNTS,
//   cbase.mounts.v2                                  LABEL_MOUNTS_V2 — the first two also on volume and network of the project container)
//   cbase.helper, cbase.helper.project,           the helper (helper.js — never cbase.project/cbase.instance)
//   cbase.helper.instance, cbase.helper.run
//   cbase.relocation                                  addition on the helper of a relocation (relocation/procedure.js, LABEL_RELOCATION)
//   cbase.probe                                       the start probe of the project box in the deploy
//                                                     (the deploy tool's projectbox-distribution.mjs, PROBE_LABEL)
// NOT in it: `cbase.gateway` (the gateway sets it on the USER containers in the host daemon, never in B) and everything that is only
// called like a label in a configuration (`cbase.projectrepo` in .git/config).
//
//   OWN_LABELS                          the list
//   ownKey(labels, imageLabels)   the own keys ON the container (sorted like OWN_LABELS); `labels` are the `Config.Labels` of the
//                                          container, `imageLabels` the `Config.Labels` of its image (null = unknown, `{}` = the image has none)
//   isOwnContainer(labels, imageLabels)  ownKey(…).length > 0
//   labelsFromSegments(text)                the ps form `k=v,k=v` as an object — only for the deploy side (`{{.Labels}}`); a segment
//                                          without `=` is a key with an empty value, a value with a comma falls apart (the own values never
//                                          carry one, helper.js VALUE_OK)

export const LABEL_RELOCATION = "cbase.relocation";

export const OWN_LABELS = Object.freeze([
  "cbase.project", "cbase.instance", "cbase.chat", "cbase.mounts", "cbase.mounts.v2",
  "cbase.helper", "cbase.helper.project", "cbase.helper.instance", "cbase.helper.run",
  LABEL_RELOCATION,
  "cbase.probe",
]);

const asObject = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : null);

/** The own keys that are set ON the container (not inherited from the image). `imageLabels` null = image unknown. */
export function ownKey(labels, imageLabels = null) {
  const l = asObject(labels) || {};
  const image = asObject(imageLabels);
  return OWN_LABELS.filter((k) => Object.hasOwn(l, k) && !(image && Object.hasOwn(image, k) && String(image[k]) === String(l[k])));
}

export const isOwnContainer = (labels, imageLabels = null) => ownKey(labels, imageLabels).length > 0;

/** `k=v,k=v` (ps `{{.Labels}}`) → { k: v }. */
export function labelsFromSegments(text) {
  const out = {};
  for (const segment of String(text ?? "").split(",")) {
    const g = segment.trim();
    if (!g) continue;
    const i = g.indexOf("=");
    const k = i < 0 ? g : g.slice(0, i);
    if (!Object.hasOwn(out, k)) out[k] = i < 0 ? "" : g.slice(i + 1);
  }
  return out;
}
