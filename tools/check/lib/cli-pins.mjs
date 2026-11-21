// The provider CLIs in the image as a READ quantity (guard for the dynamic workflows).
//
// `server/backend/Dockerfile` pins Claude Code and Codex in ONE `npm install -g` line. This reader is the single
// way to both numbers (status, the pin-sync guard, the baseline recorder).
//
// A missing or unreadable pin is an ERROR, never "empty = fits": unpinned, Docker takes the cached layer on every
// build, and a guard that turns "no number" into "nothing to compare" would be green on the worst day.
export const CLI_PACKAGES = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
};

export class PinError extends Error {
  constructor(error) {
    super(`Cannot read CLI pins in server/backend/Dockerfile:\n${error.map((f) => `  - ${f}`).join("\n")}`);
    this.error = error;
  }
}

// The `npm install -g` instructions of the Dockerfile, continuation lines joined, comments dropped (a comment
// about an old bump must not be read as a pin).
function installInstructions(text) {
  const logical = [];
  let accumulator = "";
  for (const raw of String(text ?? "").split("\n")) {
    if (/^\s*#/.test(raw)) continue;
    const z = raw.replace(/\s+$/, "");
    if (z.endsWith("\\")) { accumulator += z.slice(0, -1) + " "; continue; }
    logical.push(accumulator + z);
    accumulator = "";
  }
  if (accumulator) logical.push(accumulator);
  return logical.filter((z) => /\bnpm\s+(?:install|i)\b/.test(z) && /\s(?:-g|--global)\b/.test(z));
}

// { claude, codex } — or a PinError naming EVERY gap.
export function readCliPins(text) {
  const error = [];
  const pins = {};
  const words = installInstructions(text).flatMap((z) => z.split(/\s+/));
  for (const [cli, pack] of Object.entries(CLI_PACKAGES)) {
    const hits = words.filter((w) => w === pack || w.startsWith(`${pack}@`));
    if (!hits.length) { error.push(`${cli}: ${pack} appears in no "npm install -g" instruction`); continue; }
    const versions = [...new Set(hits.map((w) => w.slice(pack.length + 1)))];
    if (versions.length > 1) { error.push(`${cli}: ${pack} appears several times with different values (${versions.map((v) => v || "unpinned").join(", ")})`); continue; }
    const v = versions[0];
    if (!v) { error.push(`${cli}: ${pack} is unpinned (Docker would take the cached layer)`); continue; }
    if (!/^\d+\.\d+\.\d+$/.test(v)) { error.push(`${cli}: ${pack}@${v} is not an exact version`); continue; }
    pins[cli] = v;
  }
  if (error.length) throw new PinError(error);
  return pins;
}
