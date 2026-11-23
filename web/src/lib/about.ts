// The "About" rows of the settings: which cbase build runs, which API level the server speaks, which gateway sits in front
// and — in the desktop client — which app version wraps the page. A leaf module without imports: `ThirdPartyHints.tsx`
// renders the rows, web/test/about.test.mjs compiles this file with tsc and runs it.
//
// The one rule: a value the server did not send is UNKNOWN, never guessed. An old gateway sends no `build`, a gateway
// without its build file sends `build: "unknown"` next to its own package version — in both cases the row must not look
// like a clean build. `value: null` means "unknown"; the page translates that word, this module knows no language.

// The fields of `GET /gw/info` (gateway mode) and `GET /api/version` (local server) that the rows read. Everything is
// `unknown` on purpose: the answer comes from a server of any age.
export interface VersionInfo {
  version?: unknown;
  build?: unknown;
  commit?: unknown;
  release?: unknown;
  api?: unknown;
  gatewayVersion?: unknown;
}

// What the gateway answer contributes, copied field by field (an allowlist: whatever is not named here never arrives).
export function pickVersionInfo(j: unknown): VersionInfo {
  if (!j || typeof j !== "object") return {};
  const o = j as Record<string, unknown>;
  return { version: o.version, build: o.build, commit: o.commit, release: o.release, api: o.api, gatewayVersion: o.gatewayVersion };
}

export type AboutKey = "cbase" | "api" | "gateway" | "desktop";

export interface AboutRow {
  key: AboutKey;
  // Dictionary key of the row title (t() at render).
  label: string;
  // The value as shown, or null = unknown.
  value: string | null;
  // Dictionary key of a remark behind the value (only "build unknown": a version without a build id).
  note?: string;
}

// The build id sent by the gateway when its build file is missing.
export const BUILD_UNKNOWN = "unknown";

function text(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s && s !== BUILD_UNKNOWN ? s : null;
}

// The API level: a whole number from 1 up, otherwise unknown.
export function apiLevelOf(api: unknown): number | null {
  if (!api || typeof api !== "object") return null;
  const level = (api as { level?: unknown }).level;
  return typeof level === "number" && Number.isInteger(level) && level >= 1 ? level : null;
}

// The cbase row: the build id when the server has one; otherwise the bare version with the remark "build unknown"; otherwise
// unknown. A version alone never stands without the remark — it would read like a clean release build.
export function cbaseRow(server: VersionInfo | null): AboutRow {
  const build = text(server?.build);
  if (build) return { key: "cbase", label: "cbase", value: build };
  const version = text(server?.version);
  if (version) return { key: "cbase", label: "cbase", value: version, note: "build unknown" };
  return { key: "cbase", label: "cbase", value: null };
}

/**
 * The rows in their order.
 * - `server`: the version answer (null = none or unreadable → every server value unknown).
 * - `gatewayMode`: only then is there a "Gateway" row — the local server has no gateway in front.
 * - `desktop`: `undefined` = not in the desktop client (no row); `null` = a desktop client that does not report its version
 *   (older client) → unknown; a string = its version.
 */
export function aboutRows({ server, gatewayMode, desktop }: { server: VersionInfo | null; gatewayMode: boolean; desktop?: string | null }): AboutRow[] {
  const level = apiLevelOf(server?.api);
  const rows: AboutRow[] = [cbaseRow(server), { key: "api", label: "API level", value: level === null ? null : String(level) }];
  if (gatewayMode) rows.push({ key: "gateway", label: "Gateway", value: text(server?.gatewayVersion) });
  if (desktop !== undefined) rows.push({ key: "desktop", label: "Desktop app", value: text(desktop) });
  return rows;
}
