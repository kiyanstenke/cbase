// Names of preview links in mode `names`: `<slug>-<6 of [a-z0-9]>.ngrok.app`. A leaf without server imports.
//
// slugFrom(name)     the project name as `[a-z0-9-]`, at most 20 characters; empty becomes `preview`
// randomPart()      six characters of [a-z0-9] via crypto.randomInt (never Math.random — the name is the only lock)
// domainFor(name)  both together plus `.ngrok.app`
// NAMES_ATTEMPTS    1 + 3: on a name collision (ngrok answers 4xx) up to three more attempts
import { randomInt } from "node:crypto";

export const NAMES_ATTEMPTS = 4;
export const NAMES_ZONE = "ngrok.app";
const CHARACTER = "abcdefghijklmnopqrstuvwxyz0123456789";
const UMLAUTS = { "ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss" };

export function slugFrom(name) {
  const s = String(name || "")
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => UMLAUTS[c])
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)
    .replace(/-+$/g, "");
  return s || "preview";
}

export function randomPart(n = 6) {
  let t = "";
  for (let i = 0; i < n; i++) t += CHARACTER[randomInt(CHARACTER.length)];
  return t;
}

export const domainFor = (name) => `${slugFrom(name)}-${randomPart()}.${NAMES_ZONE}`;
