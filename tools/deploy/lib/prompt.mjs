// Confirmation before destructive steps. Without a terminal (cron, CI) nothing is guessed:
// --yes must be set, otherwise the run aborts.
import readline from "node:readline";
import * as log from "../../check/lib/log.mjs";

let assumeYes = false;
export function setAssumeYes(v) {
  assumeYes = !!v;
}

export class Aborted extends Error {
  constructor(msg) {
    super(msg);
    this.aborted = true;
  }
}

export async function confirm(question, { consequence = "" } = {}) {
  if (assumeYes) {
    log.detail(`${question} → --yes`);
    return true;
  }
  if (!process.stdin.isTTY) {
    throw new Aborted(`Confirmation without a terminal: "${question}" — set --yes for unattended runs.`);
  }
  if (consequence) log.warn(consequence);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(`  ${log.bold(question)} [y/N] `, r));
  rl.close();
  const yes = /^(j|ja|y|yes)$/i.test(answer.trim());
  log.detail(`Answer: ${answer.trim() || "(empty)"}`);
  if (!yes) throw new Aborted(`Aborted at: ${question}`);
  return true;
}
