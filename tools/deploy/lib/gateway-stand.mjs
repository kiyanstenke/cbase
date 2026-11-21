// The gateway code on the host against the working tree.
//
// The gateway (server/gateway, idle reaper, container creation) is NOT in the release tree: `./deploy server` ships it only
// with the opt-in `--gateway` (targets/server.mjs deployGateway — rsync to `<root>/gateway/`, then a unit restart; all
// open event streams and terminals drop). A change there has no effect without `--gateway`, and status used not to show
// that. It is measured as in deployGateway: an rsync DRY RUN (`-n -i --checksum`, without `data/`) — what it WOULD send
// differs. Since only deployGateway writes there and always restarts afterwards, "== working tree" also means: the
// running gateway carries this code.
//
// gatewayDeviations(stdout)  the files the dry run would send (lines `<f…`/`>f…` of the itemization); directories and
//   pure timestamps (`.d..t……`, `.f..t……`) are no deviation of the code.
// gatewayRow(r)              the status row from the dry-run result (`{ code, stdout, stderr }` from probe):
//   ok "== working tree", warn "DEVIATES: <files> — …--gateway", warn "not measured" (rsync failed — unknown is
//   not equal).
// Guard: tools/deploy/gateway-stand.test.mjs (including the wiring in targets/status.mjs).

export const GATEWAY_ROW = "Gateway-Code (Host)";

export function gatewayDeviations(stdout) {
  return String(stdout || "")
    .split("\n")
    .map((z) => z.replace(/\r$/, ""))
    .filter((z) => /^[<>]f/.test(z))
    .map((z) => z.slice(z.indexOf(" ") + 1).trim())
    .filter(Boolean);
}

export function gatewayRow(r) {
  if (!r || r.code !== 0) {
    const reason = String(r?.stderr || "").trim().split("\n").pop() || `Exit ${r?.code ?? "?"}`;
    return [GATEWAY_ROW, `not measured (rsync dry run: ${reason.slice(0, 160)})`, "warn"];
  }
  const ab = gatewayDeviations(r.stdout);
  if (!ab.length) return [GATEWAY_ROW, "== working tree (the running gateway carries it)", "ok"];
  const list = ab.length > 4 ? `${ab.slice(0, 4).join(", ")} and ${ab.length - 4} more` : ab.join(", ");
  return [GATEWAY_ROW, `DEVIATES: ${list} — takes effect only after \`./deploy server --gateway\` (restart, open streams drop)`, "warn"];
}
