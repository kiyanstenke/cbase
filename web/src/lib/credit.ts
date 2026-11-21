// Credit ("Extra usage") of the Claude account and the credit gate.
//
// Credit is the pot BEYOND the time window: when it is on, the provider keeps billing
// once the 5-hour or weekly window is full — against real money. cbase cannot
// switch that off (no flag, no environment variable; the provider's server decides). What cbase can do
// is refuse the START: from CREDIT_GATE_PERCENT on
// no new turn begins, it is parked as with the time limit.
//
// Two numbers stand side by side on purpose and mean different things:
// 98 ("exhausted", EXHAUSTED_PERCENT in the backend) means "wait, nothing gets through any more";
// 99 means "do not start anything new".
//
// The number here is a FALLBACK, not a source: the threshold comes from the server as `threshold` of
// `GET /api/credit-gate` (START_GATE_PERCENT in limits.js), and every label — usage page
// and chat strip alike (`useGateThreshold` in LimitStrip.tsx) — shows THAT. The constant only
// carries until the first answer is there or if it fails to arrive. It must not become a second 99 of its own
// in the chat strip — two numbers that merely happen to be equal.
export const CREDIT_GATE_PERCENT = 99;

/** Credit state of the account. Purely descriptive — the display translates, not this module. */
export interface Credit {
  /** The endpoint delivered a credit block at all. `false` does not exist here:
   *  if the block is missing, the result is `null` — "not delivered" is not "no credit". */
  existing: true;
  /** Is the pot switched on? `null` = the field was missing, so unknown — NOT "off".
   *  (Empty is not unknown: a missing value must not be read as no.) */
  on: boolean | null;
  /** Monthly cap of the account, in `currency`. */
  limit: number | null;
  /** Already used, in `currency`. */
  used: number | null;
  /** Utilization of the cap in percent (0…100). */
  utilization: number | null;
  /** Currency symbol or code, "" if the endpoint names none. */
  currency: string;
  /** Raw identifier why the pot is off (e.g. "out_of_credits"). NEVER display —
   *  `creditReasonSentence` turns it into a sentence. */
  reason: string;
}

const count = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
// The endpoint speaks snake_case, the backend's processing camelCase. Accepting both spellings
// in ONE place is cheaper than carrying them through the UI.
const field = (o: Record<string, unknown>, ...names: string[]): unknown => {
  for (const n of names) if (o[n] !== undefined && o[n] !== null) return o[n];
  return undefined;
};

/** `null` means "the endpoint said nothing about credit" — then the view shows nothing. */
export function normCredit(raw: unknown): Credit | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  return {
    existing: true,
    on: bool(field(o, "is_enabled", "isEnabled", "enabled")),
    limit: count(field(o, "monthly_limit", "monthlyLimit", "limit")),
    used: count(field(o, "used_credits", "usedCredits", "used")),
    utilization: count(field(o, "utilization", "utilization")),
    currency: String(field(o, "currency", "currency") ?? ""),
    reason: String(field(o, "disabled_reason", "disabledReason", "reason") ?? ""),
  };
}

/**
 * Why the pot is off — as a sentence, never as an identifier. An unknown reason gets the
 * general sentence: a string like "out_of_credits" on the screen is information for the developer,
 * not for the user.
 */
export function creditReasonSentence(reason: string, t: (k: string) => string): string {
  switch (String(reason || "").trim().toLowerCase()) {
    case "":
    case "not_enabled":
    case "never_enabled":
      return t("Usage credits are not enabled for this account.");
    case "out_of_credits":
    case "no_credits":
      return t("The usage credits are used up.");
    case "spend_limit_reached":
    case "monthly_limit_reached":
    case "limit_reached":
      return t("The monthly spend limit has been reached.");
    case "disabled_by_admin":
    case "admin_disabled":
    case "org_disabled":
      return t("Turned off by the organization.");
    default:
      return t("Usage credits are currently turned off.");
  }
}

/** Amount with currency if one is known — else bare. `null` stays "—". */
export function creditAmount(n: number | null, currency: string, loc: string): string {
  if (n === null) return "—";
  const z = n.toLocaleString(loc, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${currency} ${z}` : z;
}

// ── The gate is its OWN route ────────────────────────────────────────────────
//
// Route and field name live here and not in the view, because exactly this once killed the
// switch: the usage page read and wrote it as a field `creditGate` on
// `/api/auto-continue`. That field name exists nowhere in the backend — the server answered
// 200 with `{ok:true, enabled:true}`, the client read `r.creditGate` (undefined) and flipped
// the switch straight back. Worse: `PUT /api/auto-continue` reads a MISSING
// `enabled` as ON, so every click on the credit switch actually switched
// auto-continue on — in both directions. iOS had the separation from the start
// (AutoContinueSection.swift).
//
// Two settings, two routes, two defaults (auto-continue ON, gate OFF) and two
// side effects when switching off. A shared body would silently flip
// the other when flipping one.
export const CREDIT_GATE_ROUTE = "/api/credit-gate";

/** What the route says about the gate. `threshold` comes from the SERVER — one number, one source. */
export interface CreditGateStatus {
  on: boolean;
  threshold: number;
}

/** The body both directions send. Explicitly a real bool: an omitted
 *  field is a silent OFF on this route (and one route over a silent ON). */
export const gateBody = (on: boolean): { enabled: boolean } => ({ enabled: on });

/**
 * `null` means "the answer did not confirm the state" — NOT "off". This is exactly the
 * distinction that was missing: `!!r.creditGate` turned an answer without the field into a
 * confident "off", and the switch claimed a state nobody had set.
 */
export function normCreditGate(raw: unknown): CreditGateStatus | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.enabled !== "boolean") return null;
  const s = count(o.threshold);
  return { on: o.enabled, threshold: s !== null && s > 0 && s <= 100 ? s : CREDIT_GATE_PERCENT };
}

/** The call form of `api()` — as a parameter, so this module stays import-free and thus checkable without a
 *  browser (web/test compiles it as a single file). */
export type GateCall = (path: string, opts?: { method?: string; body?: string }) => Promise<unknown>;

/** Read the state of the gate. `null` = the route said nothing usable. */
export async function loadCreditGate(call: GateCall): Promise<CreditGateStatus | null> {
  return normCreditGate(await call(CREDIT_GATE_ROUTE));
}

/**
 * Set the gate. Throws if the answer does not confirm the new state — a setting
 * that costs waiting time and money must not rest on a "probably".
 */
export async function setCreditGate(call: GateCall, on: boolean): Promise<CreditGateStatus> {
  const state = normCreditGate(
    await call(CREDIT_GATE_ROUTE, { method: "PUT", body: JSON.stringify(gateBody(on)) }),
  );
  if (!state) throw new Error("The response does not state the state of the gate.");
  return state;
}

/**
 * Did the credit gate create this wait row? Only then does the chat show "Start anyway"
 * instead of "Try now", and only then would a countdown be a promise nobody made.
 *
 * The explicit marker `gate` of the server is read; `reason` is the second source for
 * older answers. Comparing `reason === "gate"` — which the web alone used to do —
 * was ALWAYS false: the server writes `"credit"` there.
 */
export function isGateWaitRow(w: { gate?: boolean; reason?: string } | null | undefined): boolean {
  return !!w && (w.gate === true || w.reason === "credit");
}
